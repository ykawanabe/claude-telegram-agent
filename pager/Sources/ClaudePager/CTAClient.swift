import Foundation

/// Thin wrapper around the companion agent's `cta` CLI.
///
/// Pager used to re-implement process detection (greping `ps`, `tmux ls`,
/// `launchctl list`) which silently broke any time the agent renamed a
/// session, switched runtime, or moved a file. With `cta` providing a
/// versioned JSON status, the agent owns the contract — Pager just renders
/// what cta reports. As long as `schema_version` stays 1, agent-side changes
/// are invisible to Pager.
///
/// If `cta` isn't installed yet (older agent install, or agent never
/// installed), every call here surfaces a typed error so the UI can show
/// a meaningful "agent not installed" state instead of a generic red.
enum CTAClient {
    /// Version of the JSON contract this client speaks. Agent's `cta` script
    /// emits `schema_version` in every status payload; we only parse v1.
    /// Mismatch is reported as `.unsupportedSchema` so the UI can prompt for
    /// an agent upgrade rather than silently rendering stale data.
    static let supportedSchemaVersion = 1

    /// Mirrors `cta status --json` schema_version=1. Field-by-field Codable
    /// shape — easier to evolve than free-form JSONSerialization parsing.
    struct AgentStatusJSON: Decodable, Equatable {
        let schemaVersion: Int
        let launchAgent: LaunchAgent
        let claude: Claude
        let telegramMcp: TelegramMcp
        let tmux: Tmux
        // Optional so older `cta` builds (pre-caffeinate) still decode. New
        // Pager + old agent: field absent → caffeinate nil → UI shows "Off".
        let caffeinate: Caffeinate?
        let lastActivity: String?

        struct LaunchAgent: Decodable, Equatable {
            let label: String
            let loaded: Bool
        }
        struct Claude: Decodable, Equatable {
            let pid: Int?
            let rssMb: Int?
            enum CodingKeys: String, CodingKey { case pid; case rssMb = "rss_mb" }
        }
        struct TelegramMcp: Decodable, Equatable {
            let alive: Bool
        }
        struct Tmux: Decodable, Equatable {
            let claude: Session
            let watchdog: Session
            struct Session: Decodable, Equatable {
                let name: String
                let alive: Bool
            }
        }
        struct Caffeinate: Decodable, Equatable {
            let alive: Bool
            let pid: Int?
        }
        /// FDA probe result, written by the poller in the launchd TCC context.
        /// Optional: older agents (pre-P6d) don't emit it → nil ("unknown").
        let fileAccess: FileAccess?
        struct FileAccess: Decodable, Equatable {
            /// True only when every probed protected folder is readable.
            let protectedOk: Bool
            /// Per-folder result so the UI can name what's still blocked.
            let probed: [Folder]?
            let checkedAt: String?
            struct Folder: Decodable, Equatable {
                let path: String
                let ok: Bool
            }
            /// Folders the agent still can't reach (the prompt-prone set).
            var blockedPaths: [String] { (probed ?? []).filter { !$0.ok }.map(\.path) }
            enum CodingKeys: String, CodingKey {
                case protectedOk = "protected_ok"
                case probed
                case checkedAt = "checked_at"
            }
        }

        enum CodingKeys: String, CodingKey {
            case schemaVersion = "schema_version"
            case launchAgent = "launch_agent"
            case claude
            case telegramMcp = "telegram_mcp"
            case tmux
            case caffeinate
            case lastActivity = "last_activity"
            case fileAccess = "file_access"
        }
    }

    enum CTAError: Error, Equatable {
        /// `cta` not found on any candidate path. Agent likely not installed,
        /// or installed pre-v0.1.0.
        case notInstalled
        /// `cta status --json` ran but exited non-zero. Carries stderr for
        /// surfacing in Diagnostics.
        case nonZeroExit(code: Int32, stderr: String)
        /// JSON parse failed — usually a `cta` newer than this Pager build
        /// (schema_version bumped) or a corrupted output.
        case parseFailed(message: String)
        /// `schema_version` doesn't match `supportedSchemaVersion`. Agent
        /// is newer than Pager (or vice versa); user should upgrade the lagger.
        case unsupportedSchema(got: Int, expected: Int)
    }

    /// State directory: where the agent writes paired.json, topics.json, agent.log,
    /// etc. Mirrors `stateDir()` in agent/lib/paths.ts and `$STATE_DIR` in cli/cta.
    /// Respects `CTA_STATE_DIR` for tests and custom installs; defaults to
    /// `~/.pager` (post-rename from `~/.claude-telegram-agent`). Centralizing here
    /// prevents the same legacy-hardcode bug that bit cli/cta where the cta script
    /// and the agent looked at different state files. Regression-guarded by
    /// CTAClientTests.stateDir_*.
    static var stateDir: String {
        if let override = ProcessInfo.processInfo.environment["CTA_STATE_DIR"], !override.isEmpty {
            return override
        }
        return "\(NSHomeDirectory())/.pager"
    }

    /// Where to look for `cta`. Order matters: install.sh places it at
    /// `~/.local/bin/cta`, so we check user-bin first. Homebrew paths are
    /// included for hypothetical future package installs.
    private static let ctaCandidates: [String] = {
        let home = NSHomeDirectory()
        return [
            "\(home)/.local/bin/cta",
            "/opt/homebrew/bin/cta",
            "/usr/local/bin/cta",
        ]
    }()

    /// Resolved absolute path to `cta`, or nil if not found. Cached because
    /// PATH lookups happen on every poll (5s) and the install location
    /// doesn't move at runtime — if the user installs `cta` while Pager is
    /// running, they need to relaunch Pager (already documented elsewhere).
    private static let resolvedPath: String? = {
        ctaCandidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }()

    /// Returns true if `cta` is installed and executable. Cheap — no shell-out.
    static var isInstalled: Bool { resolvedPath != nil }

    /// Resolved cta executable path, or nil when not installed. Exposed so
    /// long-running streaming subprocesses (WatchLive --follow) can spawn
    /// cta directly without re-implementing path resolution.
    static var executablePath: String? { resolvedPath }

    /// The synthetic "Poller" sidebar row's content. P6b: there is no `poller`
    /// tmux session anymore — the poller's stdout is persisted to
    /// $STATE_DIR/agent.log by the LaunchAgent (StandardOutPath), so we tail
    /// that file instead of `tmux capture-pane`. `session` is ignored (there's
    /// only the one agent log now). Same WatchResult shape as before.
    static func watchSystemSession(session: String, lines: Int) -> WatchResult {
        let path = "\(stateDir)/agent.log"
        guard let data = FileManager.default.contents(atPath: path),
              let text = String(data: data, encoding: .utf8) else {
            return .sessionDead(stderr: "agent.log not found at \(path)")
        }
        let allLines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let tail = allLines.suffix(lines).joined(separator: "\n")
        return .ok(tail)
    }

    /// Run `cta status --json`. Blocking. Caller should be off the main thread.
    static func status() throws -> AgentStatusJSON {
        let raw = try run(args: ["status", "--json"])
        let decoder = JSONDecoder()
        let decoded: AgentStatusJSON
        do {
            decoded = try decoder.decode(AgentStatusJSON.self, from: raw)
        } catch {
            throw CTAError.parseFailed(message: String(describing: error))
        }
        if decoded.schemaVersion != supportedSchemaVersion {
            throw CTAError.unsupportedSchema(
                got: decoded.schemaVersion,
                expected: supportedSchemaVersion
            )
        }
        return decoded
    }

    /// Start the agent: load the poller + watchdog LaunchAgents. Idempotent —
    /// `cta start` is safe to call when already running (a healthy poller is
    /// never restarted).
    @discardableResult
    static func start() throws -> String {
        let data = try run(args: ["start"])
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// Stop the agent: boot out the poller + watchdog LaunchAgents. Idempotent.
    @discardableResult
    static func stop() throws -> String {
        let data = try run(args: ["stop"])
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// Toggle `caffeinate -i` via the agent — `cta config caffeinate <on|off>`.
    /// The agent owns the subprocess + PID file; Pager only decides whether
    /// it should be running based on user toggle + AC-only policy + power
    /// state. Idempotent (cta returns "Already running" / "Not running"
    /// cleanly when the state already matches).
    @discardableResult
    static func setCaffeinate(on: Bool) throws -> String {
        let data = try run(args: ["config", "caffeinate", on ? "on" : "off"])
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// Set the idle-daemon-eviction threshold in minutes — `cta config
    /// idle-evict <minutes>` (0 disables). cta writes $STATE_DIR/settings.json,
    /// which the poller live-reloads each poll loop, so the change applies
    /// within ~25s with no restart. Pager mutates this through cta (not a
    /// direct file write) because STATE_DIR is agent-owned — same idiom as
    /// mounts + caffeinate.
    @discardableResult
    static func setIdleEvict(minutes: Int) throws -> String {
        let data = try run(args: ["config", "idle-evict", String(max(0, minutes))])
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// Enable or disable mid-turn auto-steer — `cta config interrupt-steer
    /// on|off`. cta writes `interrupt_on_message` into $STATE_DIR/settings.json,
    /// which the poller live-reloads each poll loop (no restart needed). When on,
    /// a message sent while Claude is busy interrupts and redirects the running
    /// turn (debounced); when off, new messages queue until the turn ends (legacy
    /// behavior). Mirrors setIdleEvict in structure — same error handling and
    /// threading contract.
    @discardableResult
    static func setInterruptSteer(_ on: Bool) throws -> String {
        let data = try run(args: ["config", "interrupt-steer", on ? "on" : "off"])
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// Set the daily-digest fire time — `cta config digest-time <HH:MM>`.
    /// cta writes settings.json; the poller live-reloads within ~25s.
    /// Same mutate-through-cta idiom as setIdleEvict.
    @discardableResult
    static func setDigestTime(_ hhmm: String) throws -> String {
        let data = try run(args: ["config", "digest-time", hhmm])
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// Set the IANA timezone used by digest-time + quiet-hours —
    /// `cta config timezone <IANA>` (e.g. Asia/Tokyo).
    @discardableResult
    static func setTimezone(_ tz: String) throws -> String {
        let data = try run(args: ["config", "timezone", tz])
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// Pin the agentic runner's model — `cta config agentic-model <m>`.
    /// nil clears the pin (claude's default model applies). Applies to the
    /// NEXT agentic run; no restart needed.
    @discardableResult
    static func setAgenticModel(_ model: String?) throws -> String {
        let data = try run(args: ["config", "agentic-model", model ?? "off"])
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// Pin the agentic runner's reasoning effort — `cta config agentic-effort
    /// <low|medium|high|xhigh|max>`. nil clears the pin (claude's default,
    /// which inherits the user settings.json effortLevel).
    @discardableResult
    static func setAgenticEffort(_ effort: String?) throws -> String {
        let data = try run(args: ["config", "agentic-effort", effort ?? "off"])
        return String(data: data, encoding: .utf8) ?? ""
    }

    // MARK: - Scheduled tasks (proactive task scheduling)

    /// One scheduled task from `cta task list --json` (tasks.json v1 — each
    /// task fires a gated agentic run at its own time/days into its own
    /// topic). Reads go through cta (the versioned UI contract), never by
    /// reading tasks.json directly.
    struct TaskJSON: Decodable, Equatable, Identifiable {
        var id: String { name }
        let name: String
        let time: String
        let days: DaysValue
        let checklist: String?
        let prompt: String?
        let topic: MountJSON.ThreadIdValue
        let model: String?
        let effort: String?
        let notifyOnlyIf: String?
        let enabled: Bool

        /// "daily"/"weekdays"/"monthly:<N>"/"every:<N>" or an explicit weekday
        /// list — same string-or-other tolerant decode shape as ThreadIdValue.
        enum DaysValue: Decodable, Equatable {
            case preset(String)
            case list([String])
            init(from decoder: Decoder) throws {
                let c = try decoder.singleValueContainer()
                if let s = try? c.decode(String.self) { self = .preset(s) }
                else { self = .list(try c.decode([String].self)) }
            }
            var label: String {
                switch self {
                case .preset(let s):
                    if s == "weekdays" { return "Weekdays" }
                    if s.hasPrefix("monthly:") { return "Monthly (day \(s.dropFirst(8)))" }
                    if s.hasPrefix("every:") { return "Every \(s.dropFirst(6))d" }
                    return "Daily"
                case .list(let l):
                    return l.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: ", ")
                }
            }
        }
    }

    /// Last-run summary for a task (icon + relative age), read from
    /// $STATE_DIR/task-runs/<name>.json. nil when never run.
    static func taskLastRun(_ name: String) -> String? {
        struct Rec: Decodable { let at: String; let status: String?; let suppressed: Bool? }
        let path = "\(stateDir)/task-runs/\(name).json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let r = try? JSONDecoder().decode(Rec.self, from: data),
              let at = ISO8601DateFormatter().date(from: r.at) else { return nil }
        let icon = r.status == "done" ? (r.suppressed == true ? "🔕" : "✅")
                 : r.status == "timeout" ? "⏱" : "⚠️"
        let secs = Date().timeIntervalSince(at)
        let ago = secs < 3600 ? "\(Int(secs/60))m" : secs < 86400 ? "\(Int(secs/3600))h" : "\(Int(secs/86400))d"
        return "\(icon) \(ago) ago"
    }

    private struct TasksListJSON: Decodable {
        let version: Int
        let tasks: [TaskJSON]
    }

    /// List scheduled tasks. Blocking; call off the main thread.
    static func listTasks() throws -> [TaskJSON] {
        let data = try run(args: ["task", "list", "--json"])
        return try JSONDecoder().decode(TasksListJSON.self, from: data).tasks
    }

    @discardableResult
    static func taskAdd(name: String, time: String, days: String, checklist: String?,
                        prompt: String?, topic: String, model: String? = nil,
                        effort: String? = nil, notifyOnlyIf: String? = nil) throws -> String {
        var args = ["task", "add", name, "--time", time, "--days", days, "--topic", topic]
        if let c = checklist, !c.isEmpty { args += ["--checklist", c] }
        if let p = prompt, !p.isEmpty { args += ["--prompt", p] }
        if let m = model, !m.isEmpty { args += ["--model", m] }
        if let e = effort, !e.isEmpty { args += ["--effort", e] }
        if let n = notifyOnlyIf, !n.isEmpty { args += ["--notify-only-if", n] }
        let data = try run(args: args)
        return String(data: data, encoding: .utf8) ?? ""
    }

    @discardableResult
    static func taskRemove(_ name: String) throws -> String {
        let data = try run(args: ["task", "rm", name])
        return String(data: data, encoding: .utf8) ?? ""
    }

    @discardableResult
    static func taskSetEnabled(_ name: String, _ on: Bool) throws -> String {
        let data = try run(args: ["task", on ? "on" : "off", name])
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// Queue an immediate fire (touch-flag consumed by the poller's next
    /// tick). Does not consume the day's scheduled fire.
    @discardableResult
    static func taskRun(_ name: String) throws -> String {
        let data = try run(args: ["task", "run", name])
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// Toggle the H2 daily-digest for a single mount. Shells to
    /// `cta digest <thread> on|off`. cta mutates mounts.json's `digest`
    /// field (v3 schema) via mount-store's set-digest verb; the poller
    /// live-reloads on mtime change and picks up the new state on the
    /// next housekeep tick.
    ///
    /// `sendOnEmpty: true` opts into receiving a "Nothing actionable today"
    /// confirmation message even on quiet days. Pager surfaces this as a
    /// separate sub-toggle below the main on/off — see SettingsView.
    @discardableResult
    static func setDigest(thread: String, on: Bool, sendOnEmpty: Bool = false) throws -> String {
        var args = ["digest", thread, on ? "on" : "off"]
        if on && sendOnEmpty { args.append("--send-on-empty") }
        let data = try run(args: args)
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// Scaffold a starter HEARTBEAT.md in the mount's path via `cta digest
    /// <thread> init`. Idempotent on the cta side — won't overwrite an
    /// existing file. Returns the cta stdout for surfacing in the UI
    /// (operator sees "Scaffolded …/HEARTBEAT.md" or "already exists").
    @discardableResult
    static func digestInit(thread: String) throws -> String {
        let data = try run(args: ["digest", thread, "init"])
        return String(data: data, encoding: .utf8) ?? ""
    }

    // MARK: - Mounts (Phase 2: per-topic project bindings)

    /// Mirrors a single entry in `cta list --json` → `.mounts[]`. thread_id
    /// can be a number (forum topic id), "dm" (DM root / group root), or "*"
    /// (the wildcard catch-all). label and session_id are agent-internal but
    /// useful in the UI for "auto-created vs. user-mounted" distinction.
    struct MountJSON: Decodable, Equatable, Identifiable {
        let threadId: ThreadIdValue
        let path: String
        let label: String?
        let sessionId: String?
        let tmuxSession: String
        let createdAt: String
        /// Human topic name joined in by `cta list --json` — forum-topic name
        /// for numeric thread_ids, "General" for the "dm" mount when paired
        /// to a group. Null when no name is known. Pager prefers this over
        /// re-deriving the label from threadId so the CLI stays the single
        /// source of truth for labeling.
        let topicName: String?
        /// v3 (2026-06-01): per-mount H2 daily-digest config. Absent → digest
        /// disabled for this mount. Pager renders a toggle per mount in
        /// Settings; flipping it shells to `cta digest <thread> on|off`.
        let digest: DigestConfig?

        struct DigestConfig: Decodable, Equatable {
            let enabled: Bool
            let sendOnEmpty: Bool?
        }

        var id: String { threadId.stringValue }

        /// Telegram thread_id is heterogeneously typed in mounts.json: number
        /// for forum topics, "dm" for chat root, "*" for wildcard. Custom enum
        /// keeps SwiftUI .id stable across renders.
        enum ThreadIdValue: Decodable, Equatable {
            case number(Int)
            case string(String)
            var stringValue: String {
                switch self {
                case .number(let n): return String(n)
                case .string(let s): return s
                }
            }
            init(from decoder: Decoder) throws {
                let c = try decoder.singleValueContainer()
                if let n = try? c.decode(Int.self) { self = .number(n) }
                else { self = .string(try c.decode(String.self)) }
            }
        }

        enum CodingKeys: String, CodingKey {
            case threadId = "thread_id"
            case path
            case label
            case sessionId = "session_id"
            case tmuxSession = "tmux_session"
            case createdAt = "created_at"
            case topicName = "topic_name"
            case digest
        }
    }

    struct MountsListJSON: Decodable {
        let version: Int
        let mounts: [MountJSON]
    }

    /// `cta list --json` — never throws on "empty mounts" (returns {mounts: []}).
    /// Caller should run off the main thread.
    static func listMounts() throws -> [MountJSON] {
        let raw = try run(args: ["list", "--json"])
        let decoded = try JSONDecoder().decode(MountsListJSON.self, from: raw)
        return decoded.mounts
    }

    /// `cta mount <thread> <path> [label]`. thread is "dm", "*", or a numeric
    /// forum topic id as a string (we don't bother making it an enum here —
    /// cta validates).
    @discardableResult
    static func addMount(thread: String, path: String, label: String? = nil) throws -> String {
        var args = ["mount", thread, path]
        if let l = label, !l.isEmpty { args.append(l) }
        let data = try run(args: args)
        return String(data: data, encoding: .utf8) ?? ""
    }

    @discardableResult
    static func removeMount(thread: String) throws -> String {
        let data = try run(args: ["umount", thread])
        return String(data: data, encoding: .utf8) ?? ""
    }

    // MARK: - Watch

    /// Result of `cta watch <thread>`. Exit codes 1/2 are surfaced as
    /// distinct states rather than thrown errors so the UI can render
    /// "no mount" vs "tmux dead" vs "live content" without try/catch
    /// gymnastics per render.
    enum WatchResult: Equatable {
        case ok(String)
        case noMount(stderr: String)
        case sessionDead(stderr: String)
        case error(String)
    }

    /// `cta send <thread> <text>` — deliver text + Enter into a topic's
    /// tmux pane. Mirrors the watch result enum since the same exit codes
    /// apply (no mount → noMount, tmux dead → sessionDead).
    static func send(thread: String, text: String) -> WatchResult {
        do {
            let data = try run(args: ["send", thread, text])
            return .ok(String(data: data, encoding: .utf8) ?? "")
        } catch CTAError.nonZeroExit(let code, let stderr) {
            switch code {
            case 1: return .noMount(stderr: stderr)
            case 2: return .sessionDead(stderr: stderr)
            default: return .error(stderr)
            }
        } catch {
            return .error("\(error)")
        }
    }

    /// `cta watch <thread> [--lines N] [--ansi]` — snapshot of the topic's
    /// recent session transcript (P6b renders it from the daemon's JSONL;
    /// there's no tmux pane anymore). Single-shot.
    static func watch(thread: String, lines: Int = 200, ansi: Bool = false) -> WatchResult {
        var args = ["watch", thread, "--lines", String(lines)]
        if ansi { args.append("--ansi") }
        do {
            let data = try run(args: args)
            return .ok(String(data: data, encoding: .utf8) ?? "")
        } catch CTAError.nonZeroExit(let code, let stderr) {
            switch code {
            case 1: return .noMount(stderr: stderr)
            case 2: return .sessionDead(stderr: stderr)
            default: return .error(stderr)
            }
        } catch {
            return .error("\(error)")
        }
    }

    // MARK: - Pairing

    /// `cta pair-code [--reset]` — returns the current code or a freshly
    /// generated one. Single-line stdout (trimmed). Surfaced in Pager so the
    /// user can copy it without dropping to the terminal.
    static func pairCode(reset: Bool = false) throws -> String {
        let data = try run(args: ["pair-code", reset ? "--reset" : "--show"])
        return (String(data: data, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @discardableResult
    static func unpair(keepMounts: Bool = false) throws -> String {
        var args = ["unpair"]
        if keepMounts { args.append("--keep-mounts") }
        let data = try run(args: args)
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// Mirrors paired.json schema. Read directly from disk because cta status
    /// doesn't surface paired details (and Pager doesn't need a roundtrip just
    /// to display two integers).
    struct PairedStateJSON: Decodable, Equatable {
        let chatId: Int
        let userId: Int
        let pairedAt: String

        enum CodingKeys: String, CodingKey {
            case chatId = "chat_id"
            case userId = "user_id"
            case pairedAt = "paired_at"
        }
    }

    static func pairedState() -> PairedStateJSON? {
        let path = "\(stateDir)/paired.json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        return try? JSONDecoder().decode(PairedStateJSON.self, from: data)
    }

    // MARK: - Agent settings (settings.json)

    /// Mirrors $STATE_DIR/settings.json. Read directly from disk (like
    /// pairedState) because it's a tiny file the UI needs at render time and a
    /// cta roundtrip isn't worth it. Writes go through `setIdleEvict` /
    /// `setInterruptSteer` — cta owns STATE_DIR. `idle_evict_minutes` of 0
    /// disables eviction; absent = the recommended 15-minute default.
    /// `interrupt_on_message` absent = on (matches the poller's default).
    struct SettingsJSON: Decodable, Equatable {
        let idleEvictMinutes: Int?
        let interruptOnMessage: Bool?
        let digestTime: String?
        let timezone: String?
        let agenticModel: String?
        let agenticEffort: String?
        enum CodingKeys: String, CodingKey {
            case idleEvictMinutes = "idle_evict_minutes"
            case interruptOnMessage = "interrupt_on_message"
            case digestTime
            case timezone
            case agenticModel
            case agenticEffort
        }
    }

    /// Decode $STATE_DIR/settings.json, or nil when missing/unreadable.
    /// Shared by the scheduling readers below — same direct-read idiom as
    /// idleEvictMinutes() (reads are cheap; writes go through cta).
    private static func readSettings() -> SettingsJSON? {
        let path = "\(stateDir)/settings.json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        return try? JSONDecoder().decode(SettingsJSON.self, from: data)
    }

    /// Daily-digest fire time, "09:00" when unset (the poller's default).
    static func digestTime() -> String { readSettings()?.digestTime ?? "09:00" }

    /// Configured IANA timezone, nil when unset (poller falls back to system tz).
    static func digestTimezone() -> String? { readSettings()?.timezone }

    /// Pinned agentic model, nil when unset (claude default applies).
    static func agenticModel() -> String? { readSettings()?.agenticModel }

    /// Pinned agentic reasoning effort, nil when unset (claude default applies).
    static func agenticEffort() -> String? { readSettings()?.agenticEffort }

    /// Current idle-eviction threshold in minutes (0 = explicitly disabled;
    /// missing/unreadable = recommended 15-minute default). Reads
    /// $STATE_DIR/settings.json directly.
    static func idleEvictMinutes() -> Int {
        let path = "\(stateDir)/settings.json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let decoded = try? JSONDecoder().decode(SettingsJSON.self, from: data)
        else { return 15 }
        return max(0, decoded.idleEvictMinutes ?? 15)
    }

    /// Whether mid-turn auto-steer is enabled (default true when the key is
    /// absent, matching the poller's default). Reads $STATE_DIR/settings.json
    /// directly — same idiom as idleEvictMinutes().
    static func interruptOnMessage() -> Bool {
        let path = "\(stateDir)/settings.json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let decoded = try? JSONDecoder().decode(SettingsJSON.self, from: data)
        else { return true }
        return decoded.interruptOnMessage ?? true
    }

    /// True if the topic's claude daemon appears to be mid-turn, derived from
    /// the poller's typing marker: $STATE_DIR/typing/<chatId>__<thread>.token
    /// (written at dispatch, removed at turn-end — see typing-keepalive.ts).
    /// Freshness-guarded (10 min, the keepalive max) so a marker orphaned by a
    /// crashed poller doesn't pin the indicator on forever.
    static func isGenerating(thread: String) -> Bool {
        guard let chatId = pairedState()?.chatId else { return false }
        let path = "\(stateDir)/typing/\(chatId)__\(thread).token"
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let mtime = attrs[.modificationDate] as? Date else { return false }
        return Date().timeIntervalSince(mtime) < 600
    }

    // MARK: - Topic names (best-effort harvest)

    /// Mirrors topics.json which the poller writes when it sees a
    /// forum_topic_created or forum_topic_edited service message. Bot API has
    /// no getForumTopic, so this cache is the only way to learn topic names.
    /// Topics created before the bot joined the group are absent — that's a
    /// Telegram limitation we surface to the user in the Mounts tab UI.
    struct TopicEntryJSON: Decodable, Equatable {
        let name: String
        let capturedAt: String
        enum CodingKeys: String, CodingKey {
            case name
            case capturedAt = "captured_at"
        }
    }

    struct TopicsFileJSON: Decodable {
        let version: Int
        let topics: [String: TopicEntryJSON]
    }

    /// Returns topic name → displayable string for a given chat + thread, or
    /// nil if unknown. Keyed by "<chat_id>/<thread_id>" — same format the
    /// poller writes.
    static func topicName(chatId: Int, threadId: Int) -> String? {
        let path = "\(stateDir)/topics.json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let decoded = try? JSONDecoder().decode(TopicsFileJSON.self, from: data)
        else { return nil }
        return decoded.topics["\(chatId)/\(threadId)"]?.name
    }

    /// All forum topics the poller has cached for the currently-paired chat.
    /// Used by the Add-mount picker so the user can pick from observed topics
    /// instead of having to look up a numeric thread_id. Returns
    /// (threadId, name) tuples sorted by name for stable menu ordering.
    /// Empty when unpaired, paired to a private chat (no forum topics there),
    /// or when topics.json hasn't seen any forum_topic_created/edited yet.
    static func knownTopics() -> [(threadId: Int, name: String)] {
        guard let chatId = pairedState()?.chatId else { return [] }
        let path = "\(stateDir)/topics.json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let decoded = try? JSONDecoder().decode(TopicsFileJSON.self, from: data)
        else { return [] }
        let prefix = "\(chatId)/"
        var out: [(Int, String)] = []
        for (key, entry) in decoded.topics where key.hasPrefix(prefix) {
            let tail = String(key.dropFirst(prefix.count))
            if let id = Int(tail) { out.append((id, entry.name)) }
        }
        return out.sorted { $0.1.localizedCaseInsensitiveCompare($1.1) == .orderedAscending }
    }

    // MARK: - Internals

    /// Invoke `cta` with args and capture stdout. Reads pipes before
    /// `waitUntilExit` to avoid the ~64KB pipe-buffer deadlock — `cta status`
    /// is small but `cta` is a public CLI and future subcommands may be chatty.
    private static func run(args: [String]) throws -> Data {
        guard let path = resolvedPath else {
            throw CTAError.notInstalled
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let out = Pipe()
        let err = Pipe()
        p.standardOutput = out
        p.standardError = err

        do {
            try p.run()
        } catch {
            throw CTAError.nonZeroExit(code: -1, stderr: "\(error)")
        }

        let outData = out.fileHandleForReading.readDataToEndOfFile()
        let errData = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()

        if p.terminationStatus != 0 {
            let errStr = String(data: errData, encoding: .utf8) ?? "(no stderr)"
            throw CTAError.nonZeroExit(code: p.terminationStatus, stderr: errStr)
        }
        return outData
    }
}
