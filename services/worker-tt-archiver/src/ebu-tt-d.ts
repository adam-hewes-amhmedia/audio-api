// Renders finalised stream cues to an EBU-TT-D (TTML) subtitle document — the
// broadcast-credible archive profile. Pure: cues in, XML string out.

export interface ArchiveCue {
  cue_id: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface RenderOptions {
  lang: string;
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");

/** Format a millisecond offset as TTML media time `HH:MM:SS.mmm`. */
export function formatTtmlTime(ms: number): string {
  const msPart = ms % 1000;
  const totalSec = Math.floor(ms / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(msPart, 3)}`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderEbuTtD(cues: ArchiveCue[], opts: RenderOptions): string {
  const ps = cues
    .map((c, i) =>
      `      <tt:p xml:id="p${i}" begin="${formatTtmlTime(c.start_ms)}" end="${formatTtmlTime(c.end_ms)}">${escapeXml(c.text)}</tt:p>`
    )
    .join("\n");
  const body = ps ? `\n${ps}\n    ` : "\n    ";

  return `<?xml version="1.0" encoding="UTF-8"?>
<tt:tt xmlns:tt="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xmlns:ebuttm="urn:ebu:tt:metadata" ttp:timeBase="media" ttp:cellResolution="32 15" xml:lang="${escapeXml(opts.lang)}">
  <tt:head>
    <tt:styling>
      <tt:style xml:id="s0" tts:color="#FFFFFF" tts:backgroundColor="#000000" tts:fontFamily="monospaceSansSerif" tts:fontSize="100%" tts:lineHeight="normal"/>
    </tt:styling>
    <tt:layout>
      <tt:region xml:id="r0" tts:origin="10% 80%" tts:extent="80% 15%" tts:displayAlign="after"/>
    </tt:layout>
  </tt:head>
  <tt:body>
    <tt:div region="r0" style="s0">${body}</tt:div>
  </tt:body>
</tt:tt>
`;
}
