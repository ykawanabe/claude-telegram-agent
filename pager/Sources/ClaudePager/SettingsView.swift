import SwiftUI

/// Reads + writes the canonical Telegram channel config files:
/// - ~/.claude/channels/telegram/.env       (TELEGRAM_BOT_TOKEN=...)
/// - ~/.claude/channels/telegram/access.json (allowlist policy)
final class TelegramConfig: ObservableObject {
    @Published var token: String = ""
    /// Emoji the bot reacts with on every inbound message so the user has a
    /// visible "received, processing" signal. Empty string = no reaction.
    /// Telegram only accepts a fixed whitelist of free-bot reaction emojis;
    /// invalid values are silently dropped by the plugin (`server.ts:946`).
    @Published var ackReaction: String = ""
    @Published var saveError: String? = nil
    // Note: `allowFrom` / `dmPolicy` are no longer surfaced by Pager. In
    // MULTI_TOPIC mode the poller only honors paired.json's `user_id` — the
    // access.json allowlist is dead in that path. Single-source-of-truth for
    // "who can drive this bot" is the paired user. Removed UI 2026-05-16.

    let envPath: String
    let accessPath: String
    private var debounceTask: Task<Void, Never>?

    /// Paths default to the user's `~/.claude/channels/telegram/` directory
    /// in production. Tests pass tmp paths to verify the read/write logic
    /// without touching the real config.
    init(
        envPath: String = ("~/.claude/channels/telegram/.env" as NSString).expandingTildeInPath,
        accessPath: String = ("~/.claude/channels/telegram/access.json" as NSString).expandingTildeInPath
    ) {
        self.envPath = envPath
        self.accessPath = accessPath
        load()
    }

    func load() {
        token = readToken() ?? ""
        ackReaction = readAckReaction()
    }

    /// Debounced auto-save — used for typed fields like the token so we don't
    /// hit the disk on every keystroke. Allowlist add/remove calls `save()`
    /// directly since those are discrete user actions.
    func scheduleAutoSave() {
        debounceTask?.cancel()
        debounceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard !Task.isCancelled else { return }
            self?.save()
        }
    }

    func save() {
        saveError = nil
        do {
            try writeEnv()
            try writeAccess()
        } catch {
            saveError = String(describing: error)
        }
    }

    private func readToken() -> String? {
        guard let envText = try? String(contentsOfFile: envPath, encoding: .utf8) else { return nil }
        for raw in envText.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("TELEGRAM_BOT_TOKEN=") else { continue }
            var value = String(line.dropFirst("TELEGRAM_BOT_TOKEN=".count))
            if value.hasPrefix("\"") && value.hasSuffix("\""), value.count >= 2 {
                value = String(value.dropFirst().dropLast())
            }
            return value
        }
        return nil
    }

    private func readAckReaction() -> String {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: accessPath)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return "" }
        return (json["ackReaction"] as? String) ?? ""
    }

    private func writeEnv() throws {
        var lines: [String] = []
        var replaced = false
        if let existing = try? String(contentsOfFile: envPath, encoding: .utf8) {
            for line in existing.split(separator: "\n", omittingEmptySubsequences: false) {
                if line.hasPrefix("TELEGRAM_BOT_TOKEN=") {
                    lines.append("TELEGRAM_BOT_TOKEN=\(token)")
                    replaced = true
                } else {
                    lines.append(String(line))
                }
            }
        }
        if !replaced { lines.append("TELEGRAM_BOT_TOKEN=\(token)") }

        let dir = (envPath as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let body = lines.joined(separator: "\n") + "\n"
        try body.write(toFile: envPath, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: envPath)
    }

    private func writeAccess() throws {
        var dict: [String: Any]
        if let data = try? Data(contentsOf: URL(fileURLWithPath: accessPath)),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            dict = json
        } else {
            dict = ["groups": [:], "pending": [:]]
        }
        // We no longer touch `dmPolicy` / `allowFrom` here — the poller only
        // honors paired.json's `user_id` in MULTI_TOPIC mode, so writing the
        // allowlist from Pager would give users a misleading sense of access
        // control. Leave whatever's in access.json alone.
        // Empty string → remove the key entirely so the plugin falls back to
        // its default (no reaction). Storing "" would still be falsy in JS
        // but explicit omission keeps the file clean.
        let ack = ackReaction.trimmingCharacters(in: .whitespaces)
        if ack.isEmpty {
            dict.removeValue(forKey: "ackReaction")
        } else {
            dict["ackReaction"] = ack
        }
        let data = try JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: URL(fileURLWithPath: accessPath))
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: accessPath)
    }
}

/// Default emoji written to access.json when the user flips the reaction
/// toggle on. Picked for the "I received your message" use case — eyes reads
/// as "seen" and is in Telegram's free-bot reaction whitelist. Users who
/// want a different emoji can edit access.json directly; the toggle here
/// only flips between this default and off.
let kDefaultAckEmoji = "👀"

struct SettingsView: View {
    @StateObject private var config = TelegramConfig()
    @ObservedObject var caffeinate: CaffeinateController
    @ObservedObject var monitor: StatusMonitor

    var body: some View {
        TabView {
            // App-level (Mac side): launchd, sleep prevention, Quit behavior.
            // No Telegram concepts here so users have a clear place to look
            // for "macOS app preferences" vs "bot configuration".
            PagerTab(caffeinate: caffeinate, monitor: monitor)
                .tabItem { Label("Pager", systemImage: "macbook") }

            // Scheduled tasks — proactive agentic runs (morning briefing etc.),
            // each with its own time/days/topic. Replaced the daily digest.
            TasksTab()
                .tabItem { Label("Tasks", systemImage: "clock.badge.checkmark") }

            // Bot identity + access: token, allowlist, ack reaction. Everything
            // that ends up in ~/.claude/channels/telegram/{env,access.json}.
            TelegramTab(config: config)
                .tabItem { Label("Telegram", systemImage: "paperplane") }

            PairingTab()
                .tabItem { Label("Pairing", systemImage: "link") }

            MountsTab()
                .tabItem { Label("Projects", systemImage: "folder.badge.gearshape") }

            AboutTab()
                .tabItem { Label("About", systemImage: "info.circle") }
        }
        .frame(width: 560, height: 600)
    }
}

// MARK: - Pager tab (Mac app-level prefs)

private struct PagerTab: View {
    @ObservedObject var caffeinate: CaffeinateController
    @ObservedObject var monitor: StatusMonitor
    @AppStorage("stopBotOnQuit") private var stopBotOnQuit = true
    @AppStorage("autoStartAtLogin") private var autoStartAtLogin = true
    // Default false: caffeinate doesn't fix poller silence on Apple Silicon
    // (standby/powernap freeze it regardless — see ClaudePagerApp.swift). Keep
    // all three @AppStorage default values in sync — SwiftUI resolves the
    // first registration on the key, but matching defaults protect against
    // load-order regressions.
    @AppStorage("caffeinateEnabled") private var caffeinateEnabled = false
    @AppStorage("caffeinateOnlyOnAC") private var caffeinateOnlyOnAC = true

    // Idle-daemon eviction is agent state (settings.json via cta), not a Mac
    // app pref — so it's @State loaded from cta, not @AppStorage. 0 = off;
    // missing settings use the poller's recommended 15-minute default.
    @State private var idleEvictMinutes: Int = 15
    private let idleEvictPresets = [15, 30, 60, 120]
    private let defaultIdleEvictMinutes = 15

    // Mid-turn auto-steer is also agent state (settings.json via cta). Default
    // true — mirrors the poller's out-of-box default.
    @State private var interruptSteer: Bool = true

    var body: some View {
        Form {
            Section {
                Toggle("Start Pager at login", isOn: $autoStartAtLogin)
                    .onChange(of: autoStartAtLogin) { _, on in
                        AgentControl.setAutoStartAtLogin(on)
                    }
                Toggle("Stop the bot when Pager quits", isOn: $stopBotOnQuit)
            } header: {
                Text("Launch behavior")
            } footer: {
                Text("With \"Start at login\" off, open Pager yourself each time. \"Stop the bot when Pager quits\" also shuts the bot down on ⌘Q, so it isn't left running in the background.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section {
                Toggle("Keep Mac awake while Pager is running", isOn: Binding(
                    get: { caffeinateEnabled },
                    set: { on in
                        caffeinateEnabled = on
                        caffeinate.configure(enabled: caffeinateEnabled, onlyOnAC: caffeinateOnlyOnAC)
                    }
                ))
                Toggle("Only when plugged in (recommended)", isOn: Binding(
                    get: { caffeinateOnlyOnAC },
                    set: { on in
                        caffeinateOnlyOnAC = on
                        caffeinate.configure(enabled: caffeinateEnabled, onlyOnAC: caffeinateOnlyOnAC)
                    }
                ))
                .disabled(!caffeinateEnabled)
                LabeledContent("Current state") {
                    Text(sleepStateLabel)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Sleep prevention")
            } footer: {
                Text("Keeps the Mac awake while Pager runs so the bot stays connected to Telegram. With \"Only when plugged in\" on, the Mac sleeps normally on battery to save power.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section {
                Toggle("Reset long idle conversations (saves key context first)", isOn: Binding(
                    get: { idleEvictMinutes > 0 },
                    set: { on in setIdleEvict(on ? defaultIdleEvictMinutes : 0) }
                ))
                if idleEvictMinutes > 0 {
                    Picker("After idle for", selection: Binding(
                        get: { idleEvictMinutes },
                        set: { setIdleEvict($0) }
                    )) {
                        ForEach(idleEvictPresets, id: \.self) { m in
                            Text(idleEvictLabel(m)).tag(m)
                        }
                        // Reflect a custom value set via `cta config idle-evict`
                        // so the menu shows reality instead of going blank.
                        if !idleEvictPresets.contains(idleEvictMinutes) {
                            Text(idleEvictLabel(idleEvictMinutes)).tag(idleEvictMinutes)
                        }
                    }
                }
            } header: {
                Text("Idle sessions")
            } footer: {
                Text("When a topic stays quiet this long, its Claude session closes to free memory — your next message resumes the same conversation after a short delay. If the conversation has grown large, it's also reset to a fresh session so replies stay fast and cheap; the bot saves the important context to its memory first, so it doesn't forget what matters. On by default (15 min).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section {
                Toggle("Steer running tasks", isOn: Binding(
                    get: { interruptSteer },
                    set: { on in setInterruptSteerSetting(on) }
                ))
            } header: {
                Text("Mid-turn steering")
            } footer: {
                Text("A message sent while Claude is working interrupts and redirects it. Turn this off to make new messages wait until the current task finishes (legacy behavior). Changes apply within ~25 seconds without restarting the agent.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear {
            reloadIdleEvict()
            reloadInterruptSteer()
        }
    }

    /// Load the current idle-eviction threshold from settings.json (off main).
    private func reloadIdleEvict() {
        DispatchQueue.global(qos: .userInitiated).async {
            let m = CTAClient.idleEvictMinutes()
            DispatchQueue.main.async { idleEvictMinutes = m }
        }
    }

    /// Persist a new threshold via `cta config idle-evict` (off main). Updates
    /// local state immediately for a responsive toggle; the poller catches up
    /// within a poll loop. On failure, re-read so the UI reflects reality.
    private func setIdleEvict(_ minutes: Int) {
        idleEvictMinutes = minutes
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                _ = try CTAClient.setIdleEvict(minutes: minutes)
            } catch {
                let actual = CTAClient.idleEvictMinutes()
                DispatchQueue.main.async { idleEvictMinutes = actual }
            }
        }
    }

    private func idleEvictLabel(_ minutes: Int) -> String {
        if minutes % 60 == 0 {
            let h = minutes / 60
            return h == 1 ? "1 hour" : "\(h) hours"
        }
        return "\(minutes) min"
    }

    /// Load the current interrupt-steer setting from settings.json (off main).
    private func reloadInterruptSteer() {
        DispatchQueue.global(qos: .userInitiated).async {
            let on = CTAClient.interruptOnMessage()
            DispatchQueue.main.async { interruptSteer = on }
        }
    }

    /// Persist the interrupt-steer setting via `cta config interrupt-steer`
    /// (off main). Updates local state immediately for a responsive toggle; the
    /// poller catches up within a poll loop. On failure, re-read so the UI
    /// reflects reality.
    private func setInterruptSteerSetting(_ on: Bool) {
        interruptSteer = on
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                _ = try CTAClient.setInterruptSteer(on)
            } catch {
                let actual = CTAClient.interruptOnMessage()
                DispatchQueue.main.async { interruptSteer = actual }
            }
        }
    }

    /// Same three-state model as the menu label, written for the longer
    /// Settings line. "Active" comes from cta's reported state (agent owns
    /// the subprocess), not from our local intent — so a stale or failed
    /// cta call shows up honestly here.
    private var sleepStateLabel: String {
        if !caffeinateEnabled { return "Off" }
        if monitor.status.caffeinateAlive { return "Active — Mac will not idle-sleep" }
        if caffeinateOnlyOnAC && !caffeinate.onACPower {
            return "Paused — on battery, idle sleep allowed"
        }
        return "Idle"   // toggle on but cta didn't (yet) start — usually transient
    }
}

// MARK: - Telegram tab (bot identity + access)

private struct TelegramTab: View {
    @ObservedObject var config: TelegramConfig
    @State private var authorizedUsers: [String] = []

    var body: some View {
        Form {
            Section {
                LabeledContent("Bot token") {
                    SecureField("from @BotFather", text: $config.token)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))
                        .onChange(of: config.token) { _, _ in config.scheduleAutoSave() }
                }
            } header: {
                Text("Bot identity")
            } footer: {
                Text("Get a bot token from @BotFather. Stored at ~/.claude/channels/telegram/.env (mode 600). Changes apply when the bot restarts.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section {
                Toggle("Acknowledge received messages", isOn: Binding(
                    get: { !config.ackReaction.isEmpty },
                    set: { on in
                        config.ackReaction = on ? kDefaultAckEmoji : ""
                        config.save()
                    }
                ))
            } header: {
                Text("Message reactions")
            } footer: {
                if let err = config.saveError {
                    Label(err, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                } else {
                    Text("Reacts to every inbound message so you know the bot received it. To customize which emoji is used, edit access.json directly — Telegram only accepts its fixed whitelist.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                LabeledContent("Authorized user") {
                    if authorizedUsers.isEmpty {
                        Text("Not set — pair from Telegram")
                            .foregroundStyle(.secondary)
                    } else {
                        Text(authorizedUsers.joined(separator: ", "))
                            .monospacedDigit()
                            .textSelection(.enabled)
                    }
                }
            } header: {
                Text("Access")
            } footer: {
                Text("The Telegram user ID(s) allowed to talk to the bot (the allowlist in access.json — set automatically when you /pair). To hand control to another account, unpair and pair again from that account.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear { loadAllowFrom() }
    }

    /// Read the allowlist straight from access.json (same canonical path the
    /// model writes). Display-only — mutations stay with /pair.
    private func loadAllowFrom() {
        DispatchQueue.global(qos: .userInitiated).async {
            let path = NSHomeDirectory() + "/.claude/channels/telegram/access.json"
            var users: [String] = []
            if let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let raw = json["allowFrom"] as? [Any] {
                users = raw.map { String(describing: $0) }
            }
            DispatchQueue.main.async { authorizedUsers = users }
        }
    }
}

// MARK: - Pairing tab

/// Read-mostly view of the current paired chat + buttons for the host-side
/// pairing flow (pair-code, unpair). The actual /pair <code> message is sent
/// from Telegram by the user; this tab exists so the operator can see at a
/// glance which chat owns the bot and copy the code without dropping to a
/// terminal.
private struct PairingTab: View {
    @State private var paired: CTAClient.PairedStateJSON? = nil
    @State private var code: String = ""
    @State private var status: String? = nil
    @State private var statusIsError: Bool = false
    @State private var refreshTimer: Timer? = nil

    var body: some View {
        Form {
            Section {
                if let p = paired {
                    LabeledContent("Chat") {
                        VStack(alignment: .trailing, spacing: 1) {
                            Text(p.chatId < 0 ? "Group chat" : "Direct chat")
                            Text(String(p.chatId))
                                .monospacedDigit()
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                    LabeledContent("User ID") { Text(String(p.userId)).monospacedDigit().textSelection(.enabled) }
                    LabeledContent("Paired at") { Text(p.pairedAt).foregroundStyle(.secondary).font(.caption) }
                } else {
                    LabeledContent("Status") {
                        Label("Not paired", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    }
                }
            } header: {
                Text("Current pairing")
            } footer: {
                Text("Negative chat IDs are normal — Telegram uses them for group chats. Switching chats: from the paired user account, send `/pair` (no code needed) in the chat you want to claim. The bot moves there instantly.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section {
                LabeledContent("Code") {
                    HStack {
                        Text(code.isEmpty ? "—" : code)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                        Spacer()
                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(code, forType: .string)
                            status = "Code copied to clipboard"; statusIsError = false
                        } label: { Image(systemName: "doc.on.doc") }
                            .buttonStyle(.borderless)
                            .disabled(code.isEmpty)
                            .help("Copy code")
                    }
                }
                HStack {
                    Button("Show current code") {
                        runAsync { code = try CTAClient.pairCode(reset: false) }
                    }
                    Button("Regenerate") {
                        runAsync { code = try CTAClient.pairCode(reset: true) }
                    }
                }
            } header: {
                Text("Pairing code")
            } footer: {
                Text("First-time pairing: run nothing here — just add the bot to a chat and it'll tell you to send `/pair YOUR-CODE` back. The code persists until consumed by a successful pair.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if paired != nil {
                Section {
                    HStack {
                        Button("Unpair (keep projects)") {
                            runAsync { _ = try CTAClient.unpair(keepMounts: true); reload() }
                        }
                        Spacer()
                        Button("Unpair & clear projects", role: .destructive) {
                            runAsync { _ = try CTAClient.unpair(keepMounts: false); reload() }
                        }
                    }
                } header: {
                    Text("Unpair")
                } footer: {
                    Text("Releases the chat so another account can claim the bot. \"Clear projects\" also removes every topic ↔ folder binding.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let s = status {
                Section {
                    Label(s, systemImage: statusIsError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                        .foregroundStyle(statusIsError ? .red : .green)
                        .font(.callout)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear {
            reload()
            // Auto-refresh paired state so external changes (cta pair / unpair
            // from terminal, /pair from Telegram) reflect without manual reload.
            refreshTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in reload() }
        }
        .onDisappear { refreshTimer?.invalidate(); refreshTimer = nil }
    }

    private func reload() {
        paired = CTAClient.pairedState()
    }

    /// Tiny helper: run a throwing closure off the main thread, surface result
    /// in the `status` label. Swift-Concurrency-light because the actions are
    /// snappy and we'd rather show errors inline than crash on threadingbugs.
    private func runAsync(_ block: @escaping () throws -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try block()
                DispatchQueue.main.async { status = nil; reload() }
            } catch {
                DispatchQueue.main.async {
                    status = String(describing: error)
                    statusIsError = true
                }
            }
        }
    }
}

// MARK: - Mounts tab

/// Per-topic project bindings. Each mount maps a Telegram thread_id (forum
/// topic / DM root / wildcard) to a Mac directory; the agent spawns one
/// `topic-<id>` claude session per mount. Wildcard "*" mounts get auto-spawned
/// the first time a thread without a specific mount sees traffic.
private struct MountsTab: View {
    @State private var mounts: [CTAClient.MountJSON] = []
    // Cached inputs for the picker, refreshed on the reload timer. Computing
    // these inside a render-time `var` (the old design) hit disk on every
    // SwiftUI render + every 3s tick, which churned the list and made the
    // picker feel unstable. Caching in @State keeps render pure.
    @State private var knownTopics: [(threadId: Int, name: String)] = []
    @State private var isGroup: Bool = false
    @State private var loadError: String? = nil
    @State private var refreshTimer: Timer? = nil
    @State private var actionError: String? = nil
    @State private var showHelp: Bool = false
    /// "Add a project" lives in its own sheet (a cramped inline form didn't
    /// fit this tab) — this gates it.
    @State private var showAddSheet: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            Form {
                // What this screen is for, in one plain sentence.
                Section {
                    Text("Map each Telegram topic to the Mac folder it works in.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                // Current bindings, each shown as `Topic → Folder`.
                Section {
                    if mounts.isEmpty {
                        Label("No projects yet", systemImage: "tray")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(mounts) { m in
                            let lbl = MountsPresentation.rowLabel(
                                threadId: m.threadId, topicName: m.topicName, isGroup: isGroup)
                            HStack(spacing: 8) {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(lbl.primary)
                                    if let sub = lbl.subtitle {
                                        Text(sub).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Image(systemName: "arrow.right")
                                    .font(.caption).foregroundStyle(.secondary)
                                Text(m.path)
                                    .truncationMode(.middle).lineLimit(1)
                                    .foregroundStyle(.secondary).help(m.path)
                                if let l = m.label, !l.isEmpty {
                                    Text(l)
                                        .font(.caption)
                                        .padding(.horizontal, 6).padding(.vertical, 2)
                                        .background(Color.secondary.opacity(0.15))
                                        .cornerRadius(4)
                                }
                                Spacer()
                                Button { remove(thread: m.threadId.stringValue) } label: {
                                    Image(systemName: "minus.circle")
                                }
                                .buttonStyle(.borderless)
                                .help("Remove")
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text("Current projects")
                        Spacer()
                        Button { showHelp.toggle() } label: {
                            Image(systemName: "questionmark.circle")
                        }
                        .buttonStyle(.borderless)
                        .help("What these mean")
                        .popover(isPresented: $showHelp, arrowEdge: .bottom) { helpPopover }
                    }
                } footer: {
                    if let e = loadError {
                        Label(e, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    HStack {
                        Spacer()
                        Button {
                            showAddSheet = true
                        } label: {
                            Label("Add Project…", systemImage: "plus")
                        }
                    }
                } footer: {
                    if let e = actionError {
                        Label(e, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
            .formStyle(.grouped)
        }
        .sheet(isPresented: $showAddSheet) {
            AddProjectSheet(
                mountedIds: Set(mounts.map { $0.threadId.stringValue }),
                knownTopics: knownTopics,
                isGroup: isGroup
            ) { thread, path, label in
                add(thread: thread, path: path, label: label)
            }
        }
        .onAppear {
            reload()
            refreshTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in reload() }
        }
        .onDisappear { refreshTimer?.invalidate(); refreshTimer = nil }
    }

    /// Glossary popover behind the "?" in the section header — replaces the old
    /// wall of footer text. De-jargons the plain-language labels for anyone who
    /// wants the underlying detail.
    private var helpPopover: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("What these mean").font(.headline)
            Text("**General / DM** — messages with no topic (Telegram sends these without a topic id). Shows as General in a group, DM in a private chat.")
            Text("**Default for new topics (catch-all)** — the folder used by any topic that doesn't have its own binding.")
            Text("**Topic** — a forum topic. Its name appears once the bot has seen it (Telegram can't list topics created before the bot joined, so those stay as numbers until a message arrives).")
        }
        .font(.callout)
        .padding()
        .frame(width: 360)
    }

    private func reload() {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let list = try CTAClient.listMounts()
                // Cache the picker inputs here (off-main) so render stays pure
                // and the 3s tick doesn't hit disk on the main thread.
                let topics = CTAClient.knownTopics()
                let group = (CTAClient.pairedState()?.chatId ?? 0) < 0
                DispatchQueue.main.async {
                    mounts = list
                    knownTopics = topics
                    isGroup = group
                    loadError = nil
                }
            } catch {
                DispatchQueue.main.async { loadError = String(describing: error) }
            }
        }
    }

    private func add(thread: String, path rawPath: String, label rawLabel: String) {
        let path = (rawPath as NSString).expandingTildeInPath
        let label = rawLabel.trimmingCharacters(in: .whitespaces)
        actionError = nil
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                _ = try CTAClient.addMount(thread: thread, path: path, label: label.isEmpty ? nil : label)
                DispatchQueue.main.async { reload() }
            } catch {
                DispatchQueue.main.async {
                    actionError = String(describing: error)
                }
            }
        }
    }

    private func remove(thread: String) {
        actionError = nil
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                _ = try CTAClient.removeMount(thread: thread)
                DispatchQueue.main.async { reload() }
            } catch {
                DispatchQueue.main.async { actionError = String(describing: error) }
            }
        }
    }
}

/// "Add a project" as its own sheet — the inline form didn't fit the Projects
/// tab. Owns the picker/custom-id/folder/label state; hands the validated
/// values back via onAdd and dismisses.
private struct AddProjectSheet: View {
    let mountedIds: Set<String>
    let knownTopics: [(threadId: Int, name: String)]
    let isGroup: Bool
    let onAdd: (_ thread: String, _ path: String, _ label: String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var threadSelection: String = ""
    @State private var customThreadId: String = ""
    @State private var newPath: String = ""
    @State private var newLabel: String = ""

    private var threadOptions: [MountsPresentation.ThreadOption] {
        MountsPresentation.threadOptions(
            mountedIds: mountedIds, knownTopics: knownTopics, isGroup: isGroup)
    }
    private var effectiveThreadId: String {
        threadSelection == MountsPresentation.customSentinel || threadSelection.isEmpty
            ? customThreadId.trimmingCharacters(in: .whitespaces)
            : threadSelection
    }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Topic").font(.subheadline).foregroundStyle(.secondary)
                        Picker("", selection: $threadSelection) {
                            ForEach(threadOptions) { opt in
                                Text(opt.label).tag(opt.value)
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                        if threadSelection == MountsPresentation.customSentinel {
                            TextField("topic id (e.g. 42), dm, or *", text: $customThreadId)
                                .textFieldStyle(.roundedBorder)
                        }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Folder").font(.subheadline).foregroundStyle(.secondary)
                        HStack(spacing: 6) {
                            TextField("~/projects/foo", text: $newPath)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.body, design: .monospaced))
                            Button("Choose…") { pickFolder() }
                        }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Label (optional)").font(.subheadline).foregroundStyle(.secondary)
                        TextField("e.g. iron-flow", text: $newLabel)
                            .textFieldStyle(.roundedBorder)
                    }
                } header: {
                    Text("Add a project")
                } footer: {
                    Text("Maps a Telegram topic to the Mac folder it works in. If the topic you want isn't listed, send one message in it and it'll show up here.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)

            Divider()
            HStack {
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Add") {
                    onAdd(effectiveThreadId, newPath, newLabel)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(effectiveThreadId.isEmpty
                          || newPath.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(12)
        }
        .frame(width: 440, height: 380)
        .onAppear { threadSelection = threadOptions.first?.value ?? "" }
    }

    private func pickFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Pick the project directory this Telegram thread should bind to"
        if panel.runModal() == .OK, let url = panel.url {
            newPath = url.path
        }
    }
}

private struct AboutTab: View {
    private var appVersion: String {
        let dict = Bundle.main.infoDictionary
        return dict?["CFBundleShortVersionString"] as? String ?? "dev"
    }
    private var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
    }
    private let repoURL = URL(string: "https://github.com/ykawanabe/pager-for-agents/tree/main/pager")!
    private let agentURL = URL(string: "https://github.com/ykawanabe/pager-for-agents")!

    var body: some View {
        VStack(spacing: 16) {
            Spacer().frame(height: 8)
            Image(systemName: "paperplane.fill")
                .resizable()
                .scaledToFit()
                .frame(width: 64, height: 64)
                .foregroundStyle(.tint)

            VStack(spacing: 4) {
                Text("Claude Pager")
                    .font(.title2.weight(.semibold))
                Text("v\(appVersion) (\(buildNumber))")
                    .foregroundStyle(.secondary)
            }

            Text("Menu bar status for the Claude Code Telegram agent.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Spacer().frame(height: 8)

            VStack(spacing: 6) {
                Link("GitHub — Claude Pager", destination: repoURL)
                Link("GitHub — claude-telegram-agent", destination: agentURL)
            }
            .font(.callout)
            .foregroundStyle(.primary)

            Spacer()

            Text("MIT License · © 2026 Yusuke Kawanabe")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Tasks tab (scheduled proactive runs)

/// Scheduled tasks — the first-class schedule (replaced the legacy daily
/// digest 2026-06-10). Each row is a task that fires a gated agentic run at
/// its own time/days into its own topic; "Add Task…" opens a sheet. Reads go
/// through `cta task list --json`; mutations through `cta task <verb>` — the
/// poller hot-reloads tasks.json, so changes apply live.
private struct TasksTab: View {
    @State private var tasks: [CTAClient.TaskJSON] = []
    @State private var mounts: [CTAClient.MountJSON] = []
    @State private var isGroup = false
    @State private var timezone: String = ""
    @State private var model: String = ""   // "" = claude default
    @State private var effort: String = ""  // "" = claude default
    @State private var error: String? = nil
    @State private var status: String? = nil
    @State private var showAddSheet = false
    @State private var detailTask: CTAClient.TaskJSON? = nil
    @State private var refreshTimer: Timer? = nil
    @State private var lastRuns: [String: String] = [:]

    fileprivate static let modelPresets: [(label: String, tag: String)] = [
        ("Default", ""), ("Opus", "opus"), ("Sonnet", "sonnet"), ("Haiku", "haiku"),
    ]
    fileprivate static let effortPresets: [(label: String, tag: String)] = [
        ("Default", ""), ("Low", "low"), ("Medium", "medium"),
        ("High", "high"), ("XHigh", "xhigh"), ("Max", "max"),
    ]

    var body: some View {
        Form {
            Section {
                if let err = error {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                        .font(.caption)
                }
                if tasks.isEmpty {
                    Text("No scheduled tasks yet. Add one — each task fires an agentic run at its own time, into its own topic (the morning briefing is just a task).")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                } else {
                    ForEach(tasks) { t in
                        taskRow(t)
                    }
                }
            } header: {
                Text("Scheduled tasks")
            } footer: {
                if let s = status {
                    Label(s, systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .font(.caption)
                } else {
                    Text("Tasks run unattended through the safety gate: reads run silently, anything risky would pause — so task checklists stay read-only + drafts.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                HStack {
                    Spacer()
                    Button {
                        showAddSheet = true
                    } label: {
                        Label("Add Task…", systemImage: "plus")
                    }
                }
            }

            Section {
                HStack {
                    Text("Timezone")
                    Spacer()
                    TextField("Asia/Tokyo", text: $timezone)
                        .frame(maxWidth: 160)
                        .multilineTextAlignment(.trailing)
                        .onSubmit { applyTimezone() }
                }
                Picker("Default model", selection: Binding(
                    get: { model },
                    set: { v in model = v; applyModel(v) }
                )) {
                    ForEach(Self.modelPresets, id: \.tag) { p in Text(p.label).tag(p.tag) }
                    if !model.isEmpty && !Self.modelPresets.contains(where: { $0.tag == model }) {
                        Text(model).tag(model)
                    }
                }
                Picker("Default effort", selection: Binding(
                    get: { effort },
                    set: { v in effort = v; applyEffort(v) }
                )) {
                    ForEach(Self.effortPresets, id: \.tag) { p in Text(p.label).tag(p.tag) }
                }
            } header: {
                Text("Defaults")
            } footer: {
                Text("Timezone applies to every task's fire time. Model/effort are the defaults for agentic runs (tasks + /do); Default inherits claude's own settings.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .sheet(isPresented: $showAddSheet) {
            AddTaskSheet(mounts: realMounts, isGroup: isGroup) { name, time, days, checklist, prompt, topic, model, effort, notifyOnlyIf in
                add(name: name, time: time, days: days, checklist: checklist, prompt: prompt,
                    topic: topic, model: model, effort: effort, notifyOnlyIf: notifyOnlyIf)
            }
        }
        .sheet(item: $detailTask) { t in
            TaskDetailSheet(task: t, topicLabel: topicLabel(t), lastRun: lastRuns[t.name])
        }
        .onAppear {
            reload()
            refreshTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in reload() }
        }
        .onDisappear { refreshTimer?.invalidate(); refreshTimer = nil }
    }

    private var realMounts: [CTAClient.MountJSON] {
        mounts.filter { $0.threadId.stringValue != "*" }
    }

    @ViewBuilder
    private func taskRow(_ t: CTAClient.TaskJSON) -> some View {
        HStack(spacing: 8) {
            Toggle(isOn: Binding(
                get: { t.enabled },
                set: { on in setEnabled(t.name, on) }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(t.name).font(.body)
                        if t.notifyOnlyIf != nil {
                            Image(systemName: "bell.badge").font(.caption2).foregroundStyle(.secondary)
                                .help("Only notifies on a noteworthy day (notify-only-if)")
                        }
                    }
                    Text("\(t.time) · \(t.days.label) · \(topicLabel(t)) · \(sourceLabel(t))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let last = lastRuns[t.name] {
                        Text("last: \(last)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer()
            Button { detailTask = t } label: {
                Image(systemName: "info.circle")
            }
            .buttonStyle(.borderless)
            .help("View this task's full details + checklist")
            Button("Run now") { runNow(t.name) }
                .buttonStyle(.borderless)
                .help("Fire this task immediately (doesn't consume today's scheduled fire)")
            Button { remove(t.name) } label: {
                Image(systemName: "minus.circle")
            }
            .buttonStyle(.borderless)
            .help("Remove")
        }
    }

    private func topicLabel(_ t: CTAClient.TaskJSON) -> String {
        let topicStr = t.topic.stringValue
        if let m = mounts.first(where: { $0.threadId.stringValue == topicStr }) {
            if let n = m.topicName, !n.isEmpty { return n }
            if let l = m.label, !l.isEmpty { return l }
        }
        if topicStr == "dm" { return isGroup ? "General" : "DM" }
        return "#\(topicStr)"
    }

    private func sourceLabel(_ t: CTAClient.TaskJSON) -> String {
        if let c = t.checklist, !c.isEmpty { return (c as NSString).lastPathComponent }
        return "inline prompt"
    }

    private func reload() {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let list = try CTAClient.listTasks()
                let ms = try CTAClient.listMounts()
                let group = (CTAClient.pairedState()?.chatId ?? 0) < 0
                let tz = CTAClient.digestTimezone() ?? ""
                let m = CTAClient.agenticModel() ?? ""
                let e = CTAClient.agenticEffort() ?? ""
                var runs: [String: String] = [:]
                for t in list { if let lr = CTAClient.taskLastRun(t.name) { runs[t.name] = lr } }
                DispatchQueue.main.async {
                    tasks = list; mounts = ms; isGroup = group
                    timezone = tz; model = m; effort = e
                    lastRuns = runs
                    error = nil
                }
            } catch let e {
                DispatchQueue.main.async { error = "Failed to load tasks: \(e.localizedDescription)" }
            }
        }
    }

    private func add(name: String, time: String, days: String, checklist: String?, prompt: String?,
                     topic: String, model: String?, effort: String?, notifyOnlyIf: String?) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                _ = try CTAClient.taskAdd(name: name, time: time, days: days,
                                          checklist: checklist, prompt: prompt, topic: topic,
                                          model: model, effort: effort, notifyOnlyIf: notifyOnlyIf)
                DispatchQueue.main.async { reload() }
            } catch let e {
                DispatchQueue.main.async { error = "Add failed: \(e.localizedDescription)" }
            }
        }
    }

    private func setEnabled(_ name: String, _ on: Bool) {
        DispatchQueue.global(qos: .userInitiated).async {
            do { _ = try CTAClient.taskSetEnabled(name, on); DispatchQueue.main.async { reload() } }
            catch let e { DispatchQueue.main.async { error = "Toggle failed: \(e.localizedDescription)" } }
        }
    }

    private func remove(_ name: String) {
        DispatchQueue.global(qos: .userInitiated).async {
            do { _ = try CTAClient.taskRemove(name); DispatchQueue.main.async { reload() } }
            catch let e { DispatchQueue.main.async { error = "Remove failed: \(e.localizedDescription)" } }
        }
    }

    private func runNow(_ name: String) {
        status = nil
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                _ = try CTAClient.taskRun(name)
                DispatchQueue.main.async {
                    status = "Queued '\(name)' — fires on the next poll tick (~5s)."
                    DispatchQueue.main.asyncAfter(deadline: .now() + 6) { status = nil }
                }
            } catch let e {
                DispatchQueue.main.async { error = "Run failed: \(e.localizedDescription)" }
            }
        }
    }

    private func applyTimezone() {
        let tz = timezone.trimmingCharacters(in: .whitespaces)
        guard !tz.isEmpty else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            do { _ = try CTAClient.setTimezone(tz) }
            catch let e { DispatchQueue.main.async { error = "Timezone: \(e.localizedDescription)" } }
        }
    }

    private func applyModel(_ v: String) {
        DispatchQueue.global(qos: .userInitiated).async {
            do { _ = try CTAClient.setAgenticModel(v.isEmpty ? nil : v) }
            catch let e { DispatchQueue.main.async { error = "Model: \(e.localizedDescription)" } }
        }
    }

    private func applyEffort(_ v: String) {
        DispatchQueue.global(qos: .userInitiated).async {
            do { _ = try CTAClient.setAgenticEffort(v.isEmpty ? nil : v) }
            catch let e { DispatchQueue.main.async { error = "Effort: \(e.localizedDescription)" } }
        }
    }

    fileprivate static func date(fromHHMM s: String) -> Date? {
        let parts = s.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]),
              (0...23).contains(h), (0...59).contains(m) else { return nil }
        return Calendar.current.date(bySettingHour: h, minute: m, second: 0, of: Date())
    }

    fileprivate static func hhmm(from d: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return String(format: "%02d:%02d", c.hour ?? 9, c.minute ?? 0)
    }
}

/// "New task" sheet — name, fire time, days, what to run (checklist file or
/// inline prompt), and target topic. Mirrors AddProjectSheet's structure.
private struct AddTaskSheet: View {
    let mounts: [CTAClient.MountJSON]
    let isGroup: Bool
    let onAdd: (_ name: String, _ time: String, _ days: String,
                _ checklist: String?, _ prompt: String?, _ topic: String,
                _ model: String?, _ effort: String?, _ notifyOnlyIf: String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String = ""
    @State private var fireTime: Date = TasksTab.date(fromHHMM: "07:00") ?? Date()
    @State private var daysChoice: String = "daily"   // daily | weekdays | custom
    @State private var customDays: String = ""        // e.g. "mon,wed,fri"
    @State private var sourceKind: String = "checklist"
    @State private var checklistPath: String = ""
    @State private var promptText: String = ""
    @State private var topicSelection: String = "dm"
    @State private var modelChoice: String = ""       // "" = default (global)
    @State private var effortChoice: String = ""      // "" = default (global)
    @State private var monthlyDay: Int = 1            // for daysChoice == "monthly"
    @State private var everyN: Int = 3                // for daysChoice == "every"
    @State private var notifyOnlyIf: String = ""      // "" = always notify

    private var effectiveDays: String {
        switch daysChoice {
        case "custom": return customDays.trimmingCharacters(in: .whitespaces)
        case "monthly": return "monthly:\(monthlyDay)"
        case "every": return "every:\(everyN)"
        default: return daysChoice
        }
    }
    private var isValid: Bool {
        let nameOk = name.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]*$", options: .regularExpression) != nil
        let sourceOk = sourceKind == "checklist"
            ? !checklistPath.trimmingCharacters(in: .whitespaces).isEmpty
            : !promptText.trimmingCharacters(in: .whitespaces).isEmpty
        let daysOk = daysChoice != "custom" || !customDays.trimmingCharacters(in: .whitespaces).isEmpty
        return nameOk && sourceOk && daysOk
    }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Name").font(.subheadline).foregroundStyle(.secondary)
                        TextField("e.g. morning-briefing", text: $name)
                            .textFieldStyle(.roundedBorder)
                        if !name.isEmpty && name.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]*$", options: .regularExpression) == nil {
                            Text("Start with a letter or digit, then letters/digits/. _ - only (no spaces). It becomes a filename.")
                                .font(.caption2).foregroundStyle(.red)
                        }
                    }
                    DatePicker("Fire time", selection: $fireTime, displayedComponents: .hourAndMinute)
                    Picker("Days", selection: $daysChoice) {
                        Text("Daily").tag("daily")
                        Text("Weekdays").tag("weekdays")
                        Text("Monthly").tag("monthly")
                        Text("Every N days").tag("every")
                        Text("Custom…").tag("custom")
                    }
                    if daysChoice == "custom" {
                        TextField("mon,wed,fri", text: $customDays)
                            .textFieldStyle(.roundedBorder)
                    } else if daysChoice == "monthly" {
                        Stepper("On day \(monthlyDay) of the month", value: $monthlyDay, in: 1...31)
                    } else if daysChoice == "every" {
                        Stepper("Every \(everyN) day\(everyN == 1 ? "" : "s")", value: $everyN, in: 1...365)
                    }
                    Picker("Run", selection: $sourceKind) {
                        Text("Checklist file").tag("checklist")
                        Text("Inline prompt").tag("prompt")
                    }
                    if sourceKind == "checklist" {
                        HStack(spacing: 6) {
                            TextField("~/myproject/HEARTBEAT.md", text: $checklistPath)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.body, design: .monospaced))
                            Button("Choose…") { pickChecklist() }
                        }
                    } else {
                        TextEditor(text: $promptText)
                            .font(.system(.body))
                            .frame(height: 80)
                            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.3)))
                    }
                    Picker("Topic", selection: $topicSelection) {
                        ForEach(mounts, id: \.id) { m in
                            Text(topicLabel(m)).tag(m.threadId.stringValue)
                        }
                    }
                    Picker("Model", selection: $modelChoice) {
                        ForEach(TasksTab.modelPresets, id: \.tag) { p in Text(p.label).tag(p.tag) }
                    }
                    Picker("Effort", selection: $effortChoice) {
                        ForEach(TasksTab.effortPresets, id: \.tag) { p in Text(p.label).tag(p.tag) }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Notify only if (optional)").font(.subheadline).foregroundStyle(.secondary)
                        TextField("e.g. 🚨 — deliver only when the result contains this", text: $notifyOnlyIf)
                            .textFieldStyle(.roundedBorder)
                    }
                } header: {
                    Text("New task")
                } footer: {
                    Text("The task fires an agentic run with the checklist/prompt as its ENTIRE job — keep it read-only + drafts so unattended runs never stall on approvals. \"Notify only if\" stays silent unless the result contains that marker (tell the checklist to emit it on a noteworthy day).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)

            Divider()
            HStack {
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Add") {
                    let checklist = sourceKind == "checklist"
                        ? (checklistPath as NSString).expandingTildeInPath : nil
                    let prompt = sourceKind == "prompt" ? promptText : nil
                    onAdd(name, TasksTab.hhmm(from: fireTime), effectiveDays, checklist, prompt,
                          topicSelection, modelChoice.isEmpty ? nil : modelChoice,
                          effortChoice.isEmpty ? nil : effortChoice,
                          notifyOnlyIf.isEmpty ? nil : notifyOnlyIf)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!isValid)
            }
            .padding(12)
        }
        .frame(width: 480, height: 480)
        .onAppear {
            if !mounts.contains(where: { $0.threadId.stringValue == topicSelection }) {
                topicSelection = mounts.first?.threadId.stringValue ?? "dm"
            }
        }
    }

    private func topicLabel(_ m: CTAClient.MountJSON) -> String {
        if let n = m.topicName, !n.isEmpty { return n }
        if let l = m.label, !l.isEmpty { return l }
        let s = m.threadId.stringValue
        return s == "dm" ? (isGroup ? "General" : "DM") : "#\(s)"
    }

    private func pickChecklist() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Pick the checklist markdown this task runs"
        if panel.runModal() == .OK, let url = panel.url {
            checklistPath = url.path
        }
    }
}

/// Read-only detail view for one scheduled task: full schedule + behavior +
/// the actual instructions it runs (inline prompt, or the checklist file's
/// contents). The list rows are compact; this is where you inspect "what does
/// this task actually do".
private struct TaskDetailSheet: View {
    let task: CTAClient.TaskJSON
    let topicLabel: String
    let lastRun: String?

    @Environment(\.dismiss) private var dismiss
    @State private var checklistBody: String = ""
    @State private var loadingBody = false

    private var checklistName: String {
        guard let c = task.checklist else { return "" }
        return (c as NSString).lastPathComponent
    }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section("Schedule") {
                    LabeledContent("Time", value: task.time)
                    LabeledContent("Days", value: task.days.label)
                    LabeledContent("Topic", value: topicLabel)
                    LabeledContent("Status", value: task.enabled ? "Enabled" : "Disabled")
                    if let lr = lastRun { LabeledContent("Last run", value: lr) }
                }
                Section("Behavior") {
                    LabeledContent("Model", value: task.model ?? "Default (global)")
                    LabeledContent("Effort", value: task.effort ?? "Default (global)")
                    LabeledContent("Notify") {
                        Text(task.notifyOnlyIf.map { "only if result contains \"\($0)\"" } ?? "every run")
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.trailing)
                    }
                }
                Section(task.checklist != nil ? "Checklist — \(checklistName)" : "Inline prompt") {
                    if let p = task.prompt {
                        Text(p)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else if loadingBody {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        ScrollView {
                            Text(checklistBody.isEmpty ? "(empty or unreadable — the file may have moved)" : checklistBody)
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 220)
                        if let path = task.checklist {
                            Button("Open in editor") {
                                NSWorkspace.shared.open(URL(fileURLWithPath: (path as NSString).expandingTildeInPath))
                            }
                            .font(.caption)
                        }
                    }
                }
            }
            .formStyle(.grouped)

            Divider()
            HStack {
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            .padding(12)
        }
        .frame(width: 500, height: 580)
        .onAppear { loadChecklist() }
    }

    private func loadChecklist() {
        guard let path = task.checklist else { return }
        loadingBody = true
        DispatchQueue.global(qos: .userInitiated).async {
            let body = (try? String(contentsOfFile: (path as NSString).expandingTildeInPath, encoding: .utf8)) ?? ""
            DispatchQueue.main.async { checklistBody = body; loadingBody = false }
        }
    }
}
