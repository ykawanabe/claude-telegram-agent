import XCTest
@testable import ClaudePager

/// Tests for the JSON-decode side of CTAClient — the contract with the
/// agent's `cta status --json` output. The process-spawning side is harder to
/// unit-test cleanly (Process+FileManager mocks would obscure more than they
/// reveal), so end-to-end behavior is verified by running Pager against a
/// live `cta` install. These tests pin the schema we accept.
final class CTAClientTests: XCTestCase {
    /// Schema version this Pager build accepts. Bumping requires a Pager
    /// update — this test is the canary that prevents silent drift.
    func test_supportedSchemaVersion_is_1() {
        XCTAssertEqual(CTAClient.supportedSchemaVersion, 1)
    }

    /// Happy path: parse the everything-up JSON `cta status --json` emits.
    /// Mirrors the exact shape from the agent's scripts/cta header.
    func test_decode_allFieldsPresent() throws {
        let json = """
        {
          "schema_version": 1,
          "launch_agent": {"label": "com.claude-agent", "loaded": true},
          "claude": {"pid": 12345, "rss_mb": 312},
          "telegram_mcp": {"alive": true},
          "tmux": {
            "claude": {"name": "claude", "alive": true},
            "watchdog": {"name": "watchdog", "alive": true}
          },
          "last_activity": "2026-05-12T10:00:00Z"
        }
        """.data(using: .utf8)!

        let s = try JSONDecoder().decode(CTAClient.AgentStatusJSON.self, from: json)
        XCTAssertEqual(s.schemaVersion, 1)
        XCTAssertEqual(s.launchAgent.label, "com.claude-agent")
        XCTAssertTrue(s.launchAgent.loaded)
        XCTAssertEqual(s.claude.pid, 12345)
        XCTAssertEqual(s.claude.rssMb, 312)
        XCTAssertTrue(s.telegramMcp.alive)
        XCTAssertEqual(s.tmux.claude.name, "claude")
        XCTAssertTrue(s.tmux.claude.alive)
        XCTAssertEqual(s.tmux.watchdog.name, "watchdog")
        XCTAssertTrue(s.tmux.watchdog.alive)
        XCTAssertEqual(s.lastActivity, "2026-05-12T10:00:00Z")
    }

    /// file_access is an additive field (the FDA probe, P6c/P6d). Present →
    /// decodes; absent (older agent) → nil. No schema bump.
    func test_decode_fileAccess_present() throws {
        let json = """
        {
          "schema_version": 1,
          "launch_agent": {"label": "com.claude-agent", "loaded": true},
          "claude": {"pid": 1, "rss_mb": 1},
          "telegram_mcp": {"alive": true},
          "tmux": {"claude": {"name": "poller", "alive": true}, "watchdog": {"name": "watchdog", "alive": true}},
          "last_activity": null,
          "file_access": {"protected_ok": false, "probed": [{"path": "/Users/x/Documents", "ok": true}, {"path": "/Users/x/Desktop", "ok": false}], "checked_at": "2026-05-22T00:00:00Z"}
        }
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(CTAClient.AgentStatusJSON.self, from: json)
        XCTAssertEqual(s.fileAccess?.protectedOk, false)
        XCTAssertEqual(s.fileAccess?.blockedPaths, ["/Users/x/Desktop"])
    }

    func test_decode_fileAccess_absent_isNil() throws {
        let json = """
        {
          "schema_version": 1,
          "launch_agent": {"label": "com.claude-agent", "loaded": true},
          "claude": {"pid": 1, "rss_mb": 1},
          "telegram_mcp": {"alive": true},
          "tmux": {"claude": {"name": "poller", "alive": true}, "watchdog": {"name": "watchdog", "alive": true}},
          "last_activity": null
        }
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(CTAClient.AgentStatusJSON.self, from: json)
        XCTAssertNil(s.fileAccess, "older agents omit file_access → nil")
    }

    /// Everything-down JSON. `pid`, `rss_mb`, and `last_activity` are null
    /// because the agent reports those as null when there's nothing to report
    /// (rather than omitting fields). Confirms Codable handles `null`-vs-int.
    func test_decode_nullableFields() throws {
        let json = """
        {
          "schema_version": 1,
          "launch_agent": {"label": "com.claude-agent", "loaded": false},
          "claude": {"pid": null, "rss_mb": null},
          "telegram_mcp": {"alive": false},
          "tmux": {
            "claude": {"name": "claude", "alive": false},
            "watchdog": {"name": "watchdog", "alive": false}
          },
          "last_activity": null
        }
        """.data(using: .utf8)!

        let s = try JSONDecoder().decode(CTAClient.AgentStatusJSON.self, from: json)
        XCTAssertNil(s.claude.pid)
        XCTAssertNil(s.claude.rssMb)
        XCTAssertNil(s.lastActivity)
        XCTAssertFalse(s.launchAgent.loaded)
        XCTAssertFalse(s.telegramMcp.alive)
    }

    /// Custom tmux session names from .env should round-trip through the
    /// JSON. This is the dual-repo bug we fixed for v0.1.0 — agent supports
    /// it, Pager respects it.
    func test_decode_customSessionNames() throws {
        let json = """
        {
          "schema_version": 1,
          "launch_agent": {"label": "com.claude-agent", "loaded": true},
          "claude": {"pid": 1, "rss_mb": 100},
          "telegram_mcp": {"alive": true},
          "tmux": {
            "claude": {"name": "my-bot", "alive": true},
            "watchdog": {"name": "my-watchdog", "alive": true}
          },
          "last_activity": null
        }
        """.data(using: .utf8)!

        let s = try JSONDecoder().decode(CTAClient.AgentStatusJSON.self, from: json)
        XCTAssertEqual(s.tmux.claude.name, "my-bot")
        XCTAssertEqual(s.tmux.watchdog.name, "my-watchdog")
    }

    // MARK: - State directory resolution (regression guard)
    //
    // Same class of bug as cli/cta's legacy-path hardcode: if Pager and the
    // agent read state files from different directories, paired.json /
    // topics.json lookups silently return nil and the UI shows blanks. These
    // tests pin the contract — stateDir respects $CTA_STATE_DIR and defaults
    // to ~/.pager, matching agent/lib/paths.ts:stateDir() and cli/cta:STATE_DIR.

    func test_stateDir_defaultsToHomeSlashPager() {
        // Clear any inherited override in case CI runs with one set.
        unsetenv("CTA_STATE_DIR")
        let expected = "\(NSHomeDirectory())/.pager"
        XCTAssertEqual(CTAClient.stateDir, expected)
    }

    func test_stateDir_respectsEnvOverride() {
        setenv("CTA_STATE_DIR", "/tmp/cta-pager-test", 1)
        defer { unsetenv("CTA_STATE_DIR") }
        XCTAssertEqual(CTAClient.stateDir, "/tmp/cta-pager-test")
    }

    func test_stateDir_emptyOverrideFallsBack() {
        // Empty string is treated as "unset" — protects against shells that
        // export CTA_STATE_DIR='' and would otherwise crash the lookup.
        setenv("CTA_STATE_DIR", "", 1)
        defer { unsetenv("CTA_STATE_DIR") }
        XCTAssertEqual(CTAClient.stateDir, "\(NSHomeDirectory())/.pager")
    }

    func test_pairedState_readsFromStateDir() throws {
        // Write a fixture paired.json into a temp stateDir, point CTA_STATE_DIR
        // at it, and verify pairedState() finds it. Confirms the function isn't
        // still hardcoded to the legacy path.
        let tmp = NSTemporaryDirectory() + "cta-pager-paired-test-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: tmp) }
        let payload = #"{"version":1,"chat_id":-12345,"user_id":67,"paired_at":"2026-05-16T00:00:00Z"}"#
        try payload.write(toFile: "\(tmp)/paired.json", atomically: true, encoding: .utf8)
        setenv("CTA_STATE_DIR", tmp, 1)
        defer { unsetenv("CTA_STATE_DIR") }
        let s = CTAClient.pairedState()
        XCTAssertEqual(s?.chatId, -12345)
        XCTAssertEqual(s?.userId, 67)
    }

    func test_topicName_readsFromStateDir() throws {
        let tmp = NSTemporaryDirectory() + "cta-pager-topics-test-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: tmp) }
        let payload = #"{"version":1,"topics":{"-12345/42":{"name":"Iron Flow","captured_at":"2026-05-16T00:00:00Z"}}}"#
        try payload.write(toFile: "\(tmp)/topics.json", atomically: true, encoding: .utf8)
        setenv("CTA_STATE_DIR", tmp, 1)
        defer { unsetenv("CTA_STATE_DIR") }
        XCTAssertEqual(CTAClient.topicName(chatId: -12345, threadId: 42), "Iron Flow")
        XCTAssertNil(CTAClient.topicName(chatId: -12345, threadId: 99))
    }

    // MARK: - settings.json (idle-eviction threshold)

    func test_idleEvictMinutes_readsFromStateDir() throws {
        let tmp = NSTemporaryDirectory() + "cta-pager-settings-test-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: tmp) }
        try #"{"version":1,"idle_evict_minutes":30}"#
            .write(toFile: "\(tmp)/settings.json", atomically: true, encoding: .utf8)
        setenv("CTA_STATE_DIR", tmp, 1)
        defer { unsetenv("CTA_STATE_DIR") }
        XCTAssertEqual(CTAClient.idleEvictMinutes(), 30)
    }

    func test_idleEvictMinutes_missingFileOrKey_returnsRecommendedDefault() throws {
        let tmp = NSTemporaryDirectory() + "cta-pager-settings-zero-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: tmp) }
        setenv("CTA_STATE_DIR", tmp, 1)
        defer { unsetenv("CTA_STATE_DIR") }
        // No settings.json yet → recommended 15-minute default.
        XCTAssertEqual(CTAClient.idleEvictMinutes(), 15)
        // File present but key absent (only other settings) → same default.
        try #"{"version":1}"#.write(toFile: "\(tmp)/settings.json", atomically: true, encoding: .utf8)
        XCTAssertEqual(CTAClient.idleEvictMinutes(), 15)
    }

    // MARK: - settings.json (interrupt-steer / mid-turn auto-steer)

    func test_interruptOnMessage_readsFromStateDir() throws {
        let tmp = NSTemporaryDirectory() + "cta-pager-steer-test-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: tmp) }
        // Explicit false written by `cta config interrupt-steer off`.
        try #"{"version":1,"interrupt_on_message":false}"#
            .write(toFile: "\(tmp)/settings.json", atomically: true, encoding: .utf8)
        setenv("CTA_STATE_DIR", tmp, 1)
        defer { unsetenv("CTA_STATE_DIR") }
        XCTAssertFalse(CTAClient.interruptOnMessage(), "explicit false should be read back as false")
    }

    func test_interruptOnMessage_explicitTrue() throws {
        let tmp = NSTemporaryDirectory() + "cta-pager-steer-true-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: tmp) }
        try #"{"version":1,"interrupt_on_message":true}"#
            .write(toFile: "\(tmp)/settings.json", atomically: true, encoding: .utf8)
        setenv("CTA_STATE_DIR", tmp, 1)
        defer { unsetenv("CTA_STATE_DIR") }
        XCTAssertTrue(CTAClient.interruptOnMessage())
    }

    func test_interruptOnMessage_missingFileOrKey_defaultsToTrue() throws {
        let tmp = NSTemporaryDirectory() + "cta-pager-steer-default-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: tmp) }
        setenv("CTA_STATE_DIR", tmp, 1)
        defer { unsetenv("CTA_STATE_DIR") }
        // No settings.json → default on (matches poller's out-of-box behavior).
        XCTAssertTrue(CTAClient.interruptOnMessage(), "absent file should default to true")
        // File present but key absent → still defaults to true.
        try #"{"version":1,"idle_evict_minutes":30}"#
            .write(toFile: "\(tmp)/settings.json", atomically: true, encoding: .utf8)
        XCTAssertTrue(CTAClient.interruptOnMessage(), "absent key should default to true")
    }

    func test_interruptOnMessage_coexistsWithIdleEvict() throws {
        let tmp = NSTemporaryDirectory() + "cta-pager-steer-coexist-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: tmp) }
        try #"{"version":1,"idle_evict_minutes":60,"interrupt_on_message":false}"#
            .write(toFile: "\(tmp)/settings.json", atomically: true, encoding: .utf8)
        setenv("CTA_STATE_DIR", tmp, 1)
        defer { unsetenv("CTA_STATE_DIR") }
        // Both fields decode correctly from the same file.
        XCTAssertEqual(CTAClient.idleEvictMinutes(), 60)
        XCTAssertFalse(CTAClient.interruptOnMessage())
    }
}
