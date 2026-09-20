export type VoiceIllustrationState = "idle" | "recording" | "processing" | "complete" | "attention";

/** Decorative voice-to-page artwork. The waveform remains the live input meter. */
export function VoiceIllustration({ state }: { state: VoiceIllustrationState }) {
  return (
    <svg className="voice-illustration" data-state={state} viewBox="0 0 360 210" fill="none" aria-hidden="true" focusable="false">
      <ellipse cx="169" cy="108" rx="124" ry="82" className="voice-art-wash" transform="rotate(-12 169 108)" />
      <circle cx="285" cy="147" r="38" className="voice-art-peach-wash" />
      <g className="voice-art-orbits" stroke="currentColor" strokeWidth="1">
        <ellipse cx="171" cy="109" rx="150" ry="60" transform="rotate(-20 171 109)" />
        <ellipse cx="171" cy="109" rx="144" ry="74" transform="rotate(-20 171 109)" strokeDasharray="2 8" />
      </g>
      <g className="voice-art-halo" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M49 66c-8 14-9 31-3 46M35 59c-10 20-11 37-4 56" />
        <path d="M154 34c12 10 18 24 19 39" />
      </g>
      <g transform="rotate(-13 109 110)">
        <g className="voice-art-microphone">
          <rect x="83" y="34" width="56" height="89" rx="28" className="voice-art-mic-body" strokeWidth="2" />
          <rect x="91" y="43" width="40" height="71" rx="20" className="voice-art-mic-inset" />
          <g className="voice-art-ink" strokeWidth="2.5" strokeLinecap="round">
            <path d="M101 55h20M97 65h28M97 75h28M98 85h26M102 95h18" />
            <path d="M72 88v10a39 39 0 0 0 78 0V88" className="voice-art-mic-stand" strokeWidth="4" />
            <path d="M111 138v28M91 168h40" className="voice-art-mic-stand" strokeWidth="4" />
          </g>
          <circle cx="111" cy="107" r="2" className="voice-art-ink-fill" />
        </g>
      </g>
      <path className="voice-art-ribbon" d="M150 127c33 0 25-62 64-61 21 1 30 28 6 36-27 9-28-5-13-15" strokeWidth="3" strokeLinecap="round" />
      <g transform="rotate(10 238 112)">
        <g className="voice-art-note">
          <rect x="191" y="58" width="99" height="120" rx="10" className="voice-art-note-shadow" />
          <path d="M190 49h72l21 21v91a9 9 0 0 1-9 9h-84a9 9 0 0 1-9-9V58a9 9 0 0 1 9-9Z" className="voice-art-paper" strokeWidth="1.5" />
          <path d="M262 49v14a7 7 0 0 0 7 7h14" className="voice-art-paper-fold" strokeWidth="1.5" />
          <g strokeLinecap="round" strokeWidth="4">
            <path d="M198 80h32" className="voice-art-title-line" />
            <path d="M198 98h67M198 111h57M198 124h63M198 137h36" className="voice-art-text-lines" />
          </g>
          <g className="voice-art-written" strokeLinecap="round" strokeWidth="4">
            <path d="M198 98h67M198 111h57M198 124h63M198 137h36" />
          </g>
        </g>
      </g>
      <g className="voice-art-complete">
        <circle cx="286" cy="163" r="19" className="voice-art-check-disc" />
        <path d="m278 163 5 5 10-11" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <g className="voice-art-spark" strokeWidth="2" strokeLinecap="round">
        <path d="M301 30v16m-8-8h16M295 32l12 12m0-12-12 12" />
        <path d="M55 157v12m-6-6h12" />
      </g>
      <circle cx="207" cy="22" r="4" className="voice-art-dot" />
      <circle cx="331" cy="112" r="3" className="voice-art-dot" />
    </svg>
  );
}

export function TranscriptIllustration() {
  return (
    <svg className="transcript-illustration" viewBox="0 0 76 64" fill="none" aria-hidden="true" focusable="false">
      <rect x="12" y="12" width="39" height="44" rx="6" transform="rotate(-12 12 12)" className="voice-art-wash" />
      <rect x="25" y="7" width="37" height="47" rx="6" transform="rotate(8 25 7)" className="voice-art-paper" strokeWidth="1.2" />
      <path d="m33 21 17 2m-19 7 19 3m-20 6 12 2" className="voice-art-text-lines" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M65 43v12m-6-6h12" className="voice-art-spark" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
