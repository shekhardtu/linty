// Synthetic data and an in-memory Tauri bridge for interface tests only.
export const fixture = ({
  empty = false,
  onboarding = false,
  theme = "light",
  historyCount = 18,
  update = null,
} = {}) => {
  const now = Date.now();
  const words = [
    "Let’s keep the first version focused. A clear experience matters more than another setting.",
    "Thanks for the thoughtful feedback. I’ll send the updated proposal tomorrow morning.",
    "A reminder for next week: review the notes and share the next steps with the team.",
    "The best tools make room for your ideas.",
  ];
  const transcripts = empty
    ? []
    : Array.from({ length: historyCount }, (_, i) => ({
        transcriptId: `qa-${i}`,
        finalText: words[i % 4],
        rawText: words[i % 4].toLowerCase(),
        corrected: i % 2 === 0,
        timestamp: now - i * 4 * 3600000,
        wordCount: 22 + i * 8,
        durationSeconds: 12 + i * 3,
        processingTimeMs: 1200,
        sttTimeMs: 900,
        correctionTimeMs: 200,
        engine: i % 4 ? "local" : "cloud",
        modelName: "Large Turbo Q5",
        application: {
          name: ["Notes", "Mail", "Safari"][i % 3],
          bundleId: ["com.apple.Notes", "com.apple.mail", "com.apple.Safari"][
            i % 3
          ],
        },
      }));
  // One correction already made in History, and a dictionary with one word each engine keeps missing.
  const corrections = empty
    ? []
    : [
        {
          correctionId: "corr-1",
          transcriptId: "qa-2",
          timestamp: now - 3600000,
          source: "edit",
          engine: "local",
          modelName: "Large Turbo Q5",
          language: "auto",
          application: { name: "Safari", bundleId: "com.apple.Safari" },
          wordCount: 17,
          changedRatio: 0.06,
          rewrite: false,
          pairs: [{ kind: "substitution", from: "stems", to: "steps" }],
        },
      ];
  const dictionary = empty
    ? { entries: [], suggestions: [] }
    : {
        entries: [
          {
            entryId: "dict-1",
            right: "Linty",
            wrong: ["Linti", "Lindy"],
            enabled: true,
            origin: "manual",
            timesApplied: 12,
            timesRecognized: 3,
            createdAt: now - 7 * 86400000,
            lastAppliedAt: now - 3600000,
          },
        ],
        suggestions: [
          {
            suggestionId: "sugg-1",
            right: "Tauri",
            wrong: "Tory",
            seenCount: 2,
            firstSeenAt: now - 2 * 86400000,
            lastSeenAt: now - 3600000,
            correctionIds: ["corr-0", "corr-1"],
          },
        ],
      };
  const stores = {
    1: {
      theme,
      onboardingComplete: !onboarding,
      sttMode: "local",
      selectedModelFilename: "ggml-large-v3-turbo-q5_0.bin",
      triggerKey: "fn",
      correctionEnabled: false,
      updateHistory: { lastRunVersion: "0.0.25", notice: null },
    },
    2: { transcripts },
    3: { corrections },
    4: dictionary,
  };
  let s1Downloaded = false;
  const history = { retentionDays: 0, generation: 0, revision: 1, saveAudio: false, lastCleanupAt: null };
  const sorted = (records) =>
    [...records].sort(
      (a, b) =>
        b.timestamp - a.timestamp ||
        b.transcriptId.localeCompare(a.transcriptId),
    );
  const changes = (record) => (record.rewrite ? 1 : record.pairs.length);
  const rate = (corrections, words) =>
    words
      ? Math.round(
          (corrections.reduce((n, c) => n + changes(c), 0) / words) * 1000,
        ) / 10
      : 0;
  const threshold = (days) => (days ? Date.now() - days * 86400000 : 0);
  const prune = (days) => {
    const before = threshold(days);
    const expired = new Set(
      stores[2].transcripts
        .filter((t) => t.timestamp < before)
        .map((t) => t.transcriptId),
    );
    stores[2].transcripts = stores[2].transcripts.filter(
      (t) => !expired.has(t.transcriptId),
    );
    const previous = stores[3].corrections.length;
    stores[3].corrections = stores[3].corrections.filter(
      (c) => !expired.has(c.transcriptId) && c.timestamp >= before,
    );
    if (expired.size || previous !== stores[3].corrections.length)
      history.revision++;
  };
  const usageSummary = (records) => {
    const total = records.reduce(
      (s, t) => ({
        words: s.words + t.wordCount,
        seconds: s.seconds + t.durationSeconds,
        sessions: s.sessions + 1,
        processing: s.processing + t.processingTimeMs,
        local: s.local + Number(t.engine === "local"),
      }),
      { words: 0, seconds: 0, sessions: 0, processing: 0, local: 0 },
    );
    const timed = records.filter(
      (t) => t.wordCount > 0 && t.durationSeconds > 0 && t.processingTimeMs > 0,
    );
    return {
      stats: {
        ...total,
        avgProcessingSeconds: total.sessions
          ? total.processing / total.sessions / 1000
          : 0,
        wordsPerMinute: total.seconds
          ? Math.round((total.words / total.seconds) * 60)
          : 0,
        localPercent: total.sessions
          ? Math.round((total.local / total.sessions) * 100)
          : 0,
      },
      timing: {
        words: timed.reduce((n, t) => n + t.wordCount, 0),
        seconds: timed.reduce((n, t) => n + t.durationSeconds, 0),
        processingSeconds: timed.reduce(
          (n, t) => n + t.processingTimeMs / 1000,
          0,
        ),
        sessions: timed.length,
        missingSessions: records.length - timed.length,
      },
      activeDays: new Set(
        records.map((t) => new Date(t.timestamp).toDateString()),
      ).size,
    };
  };
  const milestoneFor = (records) => {
    const total = records.reduce((n, t) => n + t.wordCount, 0);
    let threshold = 0;
    for (let scale = 1000; scale <= total; scale *= 10)
      for (const n of [scale, scale * 2.5, scale * 5])
        if (n <= total) threshold = n;
    if (!threshold) return null;
    let sum = 0;
    for (const record of [...records].reverse()) {
      sum += record.wordCount;
      if (sum >= threshold)
        return { words: threshold, timestamp: record.timestamp };
    }
    return null;
  };
  const historyCommand = (command, args) => {
    if (history.retentionDays && (history.lastCleanupAt == null || Date.now() - history.lastCleanupAt >= 86400000)) {
      const revision = history.revision;
      prune(history.retentionDays);
      history.lastCleanupAt = Date.now();
      if (history.revision !== revision) queueMicrotask(() => window.__QA__.emit('history-invalidated'));
    }
    const records = sorted(stores[2].transcripts);
    const related = stores[3].corrections.filter((c) =>
      records.some((t) => t.transcriptId === c.transcriptId),
    );
    const words = records.reduce((n, t) => n + t.wordCount, 0);
    switch (command) {
      case "history_snapshot":
        return {
          recent: records.slice(0, 20),
          total: records.length,
          oldestTimestamp: records.at(-1)?.timestamp ?? null,
          totalWords: words,
          milestone: milestoneFor(records),
          correctionCount: related.length,
          correctionRate: rate(related, words),
          audioCount: records.filter((t) => t.audio).length,
          audioBytes: records.reduce((sum, t) => sum + (t.audio?.bytes ?? 0), 0),
          ...history,
        };
      case "history_query": {
        const query = args.query.trim().toLowerCase();
        const matches = records.filter((t) =>
          `${t.finalText} ${t.application?.name ?? ""} ${t.application?.bundleId ?? ""}`
            .toLowerCase()
            .includes(query),
        );
        return {
          records: matches.slice(args.offset, args.offset + args.limit),
          total: matches.length,
        };
      }
      case "history_get":
        return records.find((t) => t.transcriptId === args.id) ?? null;
      case "history_set_save_audio":
        history.saveAudio = args.enabled;
        history.revision++;
        return;
      case "history_delete_audio":
        for (const record of records) if (args.id == null || record.transcriptId === args.id) delete record.audio;
        history.revision++;
        return;
      case "history_discard_pending_audio":
        return;
      case "history_export_audio":
        return !window.__QA__.cancelExport;
      case "history_audio": {
        if (!records.find((t) => t.transcriptId === args.id)?.audio) throw new Error("No saved audio");
        // A half-second synthetic tone, never microphone data.
        const wav = new ArrayBuffer(44 + 16000);
        const view = new DataView(wav);
        const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
        text(0, "RIFF"); view.setUint32(4, wav.byteLength - 8, true); text(8, "WAVEfmt ");
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, 16000, true);
        for (let i = 0; i < 8000; i++) view.setInt16(44 + i * 2, Math.sin(i * Math.PI * 2 * 440 / 16000) * 1000, true);
        return wav.slice(args.offset, args.offset + args.length);
      }
      case "history_save": {
        if (args.record.timestamp < threshold(history.retentionDays))
          throw new Error(
            "This transcription is outside your current retention period",
          );
        stores[2].transcripts = [
          args.record,
          ...records.filter((t) => t.transcriptId !== args.record.transcriptId),
        ];
        history.revision++;
        return;
      }
      case "history_patch": {
        const record = records.find((t) => t.transcriptId === args.id);
        if (!record) throw new Error("Transcription no longer exists");
        record.finalText = args.patch.finalText;
        history.revision++;
        return;
      }
      case "history_delete": {
        const transcript = records.find((t) => t.transcriptId === args.id);
        if (!transcript) return null;
        const corrections = related.filter((c) => c.transcriptId === args.id);
        stores[2].transcripts = records.filter(
          (t) => t.transcriptId !== args.id,
        );
        stores[3].corrections = stores[3].corrections.filter(
          (c) => c.transcriptId !== args.id,
        );
        history.revision++;
        return { transcript, corrections, generation: history.generation };
      }
      case "history_restore": {
        const { transcript, corrections, generation } = args.deleted;
        if (
          generation !== history.generation ||
          transcript.timestamp < threshold(history.retentionDays)
        )
          throw new Error("This deletion can no longer be undone");
        if (!records.some((t) => t.transcriptId === transcript.transcriptId))
          stores[2].transcripts.push({ ...transcript, audio: undefined });
        for (const correction of corrections)
          if (
            !stores[3].corrections.some(
              (c) => c.correctionId === correction.correctionId,
            )
          )
            stores[3].corrections.push(correction);
        history.revision++;
        return;
      }
      case "history_clear":
        stores[2].transcripts = [];
        stores[3].corrections = [];
        history.generation++;
        history.revision++;
        return;
      case "history_retention_preview":
        return records.filter((t) => t.timestamp < threshold(args.days)).length;
      case "history_set_retention":
        prune(args.days);
        history.retentionDays = args.days;
        history.lastCleanupAt = Date.now();
        history.generation++;
        history.revision++;
        return;
      case "history_corrections":
        return related.filter((c) => c.transcriptId === args.id);
      case "history_add_correction":
        if (!records.some((t) => t.transcriptId === args.record.transcriptId))
          throw new Error("The transcription was deleted or expired");
        if (!related.some((c) => c.correctionId === args.record.correctionId))
          stores[3].corrections.unshift(args.record);
        history.revision++;
        return;
      case "history_export":
        if (window.__QA__.cancelExport) return null;
        window.__QA__.exported = structuredClone({
          transcripts: records,
          corrections: stores[3].corrections,
        });
        return { count: records.length, path: "/synthetic/Linty-history.json" };
      case "history_usage_summary":
        return usageSummary(
          records.filter(
            (t) => t.timestamp >= args.start && t.timestamp <= args.end,
          ),
        );
      case "history_usage": {
        const retained = records.filter(
          (t) => t.timestamp >= args.start && t.timestamp <= args.end,
        );
        const stats = retained.reduce(
          (s, t) => ({
            words: s.words + t.wordCount,
            seconds: s.seconds + t.durationSeconds,
            sessions: s.sessions + 1,
            local: s.local + Number(t.engine === "local"),
            processing: s.processing + t.processingTimeMs,
          }),
          { words: 0, seconds: 0, sessions: 0, local: 0, processing: 0 },
        );
        const apps = new Map();
        for (const t of retained) {
          const id = !t.application
            ? "unattributed"
            : t.application.bundleId
              ? `bundle:${t.application.bundleId}`
              : `name:${t.application.name}`;
          const app = apps.get(id) ?? {
            id,
            name: t.application?.name ?? "Unattributed",
            bundleId: t.application?.bundleId,
            attributed: !!t.application,
            words: 0,
            seconds: 0,
            sessions: 0,
            lastUsedAt: 0,
            processingMs: 0,
            local: 0,
          };
          app.words += t.wordCount;
          app.seconds += t.durationSeconds;
          app.sessions++;
          app.lastUsedAt = Math.max(app.lastUsedAt, t.timestamp);
          app.processingMs += t.processingTimeMs;
          app.local += Number(t.engine === "local");
          apps.set(id, app);
        }
        return {
          ...usageSummary(retained),
          stats: {
            ...stats,
            avgProcessingSeconds: stats.sessions
              ? stats.processing / stats.sessions / 1000
              : 0,
            wordsPerMinute: stats.seconds
              ? Math.round((stats.words / stats.seconds) * 60)
              : 0,
            localPercent: stats.sessions
              ? Math.round((stats.local / stats.sessions) * 100)
              : 0,
          },
          applications: [...apps.values()],
          recent: retained.slice(0, 5),
          timeline: args.buckets.map((b) => {
            const list = retained.filter(
              (t) => t.timestamp >= b.timestamp && t.timestamp < b.end,
            );
            return {
              ...b,
              words: list.reduce((n, t) => n + t.wordCount, 0),
              sessions: list.length,
            };
          }),
          engines: ["local", "cloud"].map((engine) => {
            const list = retained.filter((t) => t.engine === engine);
            return {
              engine,
              sessions: list.length,
              share: stats.sessions
                ? Math.round((list.length / stats.sessions) * 100)
                : null,
              rate: rate(
                related.filter((c) =>
                  list.some((t) => t.transcriptId === c.transcriptId),
                ),
                list.reduce((n, t) => n + t.wordCount, 0),
              ),
            };
          }),
        };
      }
      default:
        throw new Error(`Unimplemented history command: ${command}`);
    }
  };
  const callbacks = new Map();
  const listeners = new Map();
  let id = 0;
  window.__QA__ = {
    stores,
    // Simulate a native archive write without a production UI write command.
    saveTranscript: async (record) => {
      await window.__TAURI_INTERNALS__.invoke("history_save", { record });
      await (await import(new URL('/src/services/history.service.ts', window.location.href).href)).refreshHistory();
    },
    secureGroqKey: "",
    history,
    calls: [],
    emittedEvents: [],
    correctionFeedback: [],
    clipboard: "",
    audioInputs: { selected: null, defaultDevice: "Built-in Microphone", devices: [
      { name: "Built-in Microphone", selectable: true },
      { name: "USB Microphone", selectable: true },
    ], error: null },
    failures: {},
    setUpdate: (next) => {
      update = next;
    },
    emit: (event, payload) => {
      for (const [key, listener] of listeners)
        if (listener.event === event)
          callbacks.get(listener.handler)?.({ event, id: key, payload });
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event, id) => listeners.delete(id),
  };
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback: (callback) => {
      const key = ++id;
      callbacks.set(key, callback);
      return key;
    },
    unregisterCallback: (key) => callbacks.delete(key),
    invoke: async (command, args = {}) => {
      window.__QA__.calls.push(command);
      if (window.__QA__.failures[command])
        throw new Error(window.__QA__.failures[command]);
      if (command === "show_correction_feedback") {
        window.__QA__.correctionFeedback.push(structuredClone(args.feedback));
        return;
      }
      if (command === "plugin:event|emit" || command === "plugin:event|emit_to") {
        window.__QA__.emittedEvents.push(structuredClone(args));
        return;
      }
      if (command === "get_groq_api_key") return window.__QA__.secureGroqKey;
      if (command === "s1_model_status") return { downloaded: s1Downloaded, loaded: false, downloading: false, progress: 0, downloadBytes: 495642462 };
      if (command === "download_s1_model") { s1Downloaded = true; return; }
      if (["prepare_s1_model", "unload_s1_model", "cancel_reformatting"].includes(command)) return;
      if (command === "set_groq_api_key") {
        window.__QA__.secureGroqKey = args.key.trim();
        return;
      }
      if (command === "remove_groq_api_key") {
        window.__QA__.secureGroqKey = "";
        delete stores[1].groqApiKey;
        stores[1].sttMode = "local";
        return;
      }
      if (command.startsWith("history_"))
        return structuredClone(historyCommand(command, structuredClone(args)));
      if (command === "get_audio_inputs") return structuredClone(window.__QA__.audioInputs);
      if (command === "start_dictation") { window.__QA__.dictationOptions = structuredClone(args.options); return 1; }
      if (command === "dictation_result") return window.__QA__.dictationOutcome ?? { record: null, warnings: [], recognized: [], corrected: [] };
      if (command === "stop_dictation") return { sample_count: 0, duration_secs: 0 };
      if (command === "set_audio_input") {
        window.__QA__.audioInputs.selected = args.name;
        stores[1].audioInputName = args.name;
        window.__QA__.emit("audio-input-changed", structuredClone(window.__QA__.audioInputs));
        return structuredClone(window.__QA__.audioInputs);
      }
      if (
        command === "plugin:store|load" ||
        command === "plugin:store|get_store"
      )
        return args.path.includes("history")
          ? 2
          : args.path.includes("corrections")
            ? 3
            : args.path.includes("dictionary")
              ? 4
              : 1;
      if (command === "plugin:store|get")
        return [stores[args.rid][args.key], args.key in stores[args.rid]];
      if (command === "plugin:store|set") {
        stores[args.rid][args.key] = args.value;
        return;
      }
      if (command === "plugin:event|listen") {
        const key = ++id;
        listeners.set(key, args);
        return key;
      }
      if (command === "plugin:event|unlisten") {
        listeners.delete(args.eventId);
        return;
      }
      if (command === "plugin:app|version") return "0.0.25";
      if (command === "plugin:clipboard-manager|write_text") {
        window.__QA__.clipboard = args.text;
        return;
      }
      if (command === "get_theme") return stores[1].theme;
      if (command === "plugin:updater|check") return update;
      if (command === "plugin:updater|download") return 11;
      if (command === "plugin:updater|install") return null;
      if (command === "plugin:process|restart") return null;
      if (command === "check_microphone") return "authorized";
      if (
        [
          "check_accessibility",
          "request_microphone",
          "request_accessibility",
          "is_local_stt_available",
        ].includes(command)
      )
        return true;
      if (command === "check_fn_key_conflict")
        return { conflict: false, usage_type: 0 };
      if (command === "get_app_icons")
        return Object.fromEntries(
          args.bundleIds.map((id) => [
            id,
            id === "com.apple.Safari"
              ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mOwbvpGEmIY1TCqYfhqAACHB7MQtp/9lwAAAABJRU5ErkJggg=="
              : null,
          ]),
        );
      if (command === "prepare_parakeet_vocabulary") return false;
      if (command === "check_model_exists")
        return args.filename === "ggml-large-v3-turbo-q5_0.bin";
      if (command === "get_available_models")
        return [
          {
            filename: "parakeet-tdt-0.6b-v3",
            name: "Parakeet TDT v3 (~500 MB) ★ Recommended",
            description: "Neural Engine · sub-second",
            size_mb: 500,
            backend: "parakeet",
          },
          {
            filename: "ggml-large-v3-turbo-q5_0.bin",
            name: "Whisper Large Turbo Q5 (574 MB)",
            description: "99 languages · vocabulary prompt",
            size_mb: 574,
            backend: "whisper",
          },
        ];
      return null;
    },
  };
};
