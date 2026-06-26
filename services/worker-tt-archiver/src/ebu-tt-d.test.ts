import { describe, it, expect } from "vitest";
import { renderEbuTtD, formatTtmlTime, type ArchiveCue } from "./ebu-tt-d.js";

describe("formatTtmlTime", () => {
  it("formats milliseconds as HH:MM:SS.mmm", () => {
    expect(formatTtmlTime(0)).toBe("00:00:00.000");
    expect(formatTtmlTime(1)).toBe("00:00:00.001");
    expect(formatTtmlTime(187120)).toBe("00:03:07.120");
    expect(formatTtmlTime(3661001)).toBe("01:01:01.001");
  });
});

describe("renderEbuTtD", () => {
  const cues: ArchiveCue[] = [
    { cue_id: 0, start_ms: 1000, end_ms: 3000, text: "We are approaching the terminal." },
    { cue_id: 1, start_ms: 3200, end_ms: 5000, text: "Mind the gap & stay safe." },
  ];

  it("produces an EBU-TT-D document with the TTML namespace", () => {
    const xml = renderEbuTtD(cues, { lang: "en" });
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('xmlns:tt="http://www.w3.org/ns/ttml"');
    expect(xml).toContain('xmlns:ebuttm="urn:ebu:tt:metadata"');
    expect(xml).toContain('xml:lang="en"');
    expect(xml).toContain("<tt:tt");
    expect(xml).toContain("</tt:tt>");
  });

  it("includes a region and a style in the head", () => {
    const xml = renderEbuTtD(cues, { lang: "en" });
    expect(xml).toContain("<tt:region");
    expect(xml).toContain("<tt:style");
    expect(xml).toMatch(/region="[^"]+"/);
  });

  it("emits one <tt:p> per cue with begin/end timings", () => {
    const xml = renderEbuTtD(cues, { lang: "en" });
    const ps = xml.match(/<tt:p\b/g) ?? [];
    expect(ps.length).toBe(2);
    expect(xml).toContain('begin="00:00:01.000"');
    expect(xml).toContain('end="00:00:03.000"');
    expect(xml).toContain('begin="00:00:03.200"');
  });

  it("xml-escapes cue text", () => {
    const xml = renderEbuTtD(cues, { lang: "en" });
    expect(xml).toContain("Mind the gap &amp; stay safe.");
    expect(xml).not.toContain("gap & stay");
  });

  it("renders empty body for no cues but stays well-formed", () => {
    const xml = renderEbuTtD([], { lang: "en" });
    expect(xml).toContain("<tt:body");
    expect((xml.match(/<tt:p\b/g) ?? []).length).toBe(0);
  });

  it("matches the golden document", () => {
    const xml = renderEbuTtD(cues, { lang: "en" });
    expect(xml).toBe(GOLDEN);
  });
});

const GOLDEN = `<?xml version="1.0" encoding="UTF-8"?>
<tt:tt xmlns:tt="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xmlns:ebuttm="urn:ebu:tt:metadata" ttp:timeBase="media" ttp:cellResolution="32 15" xml:lang="en">
  <tt:head>
    <tt:styling>
      <tt:style xml:id="s0" tts:color="#FFFFFF" tts:backgroundColor="#000000" tts:fontFamily="monospaceSansSerif" tts:fontSize="100%" tts:lineHeight="normal"/>
    </tt:styling>
    <tt:layout>
      <tt:region xml:id="r0" tts:origin="10% 80%" tts:extent="80% 15%" tts:displayAlign="after"/>
    </tt:layout>
  </tt:head>
  <tt:body>
    <tt:div region="r0" style="s0">
      <tt:p xml:id="p0" begin="00:00:01.000" end="00:00:03.000">We are approaching the terminal.</tt:p>
      <tt:p xml:id="p1" begin="00:00:03.200" end="00:00:05.000">Mind the gap &amp; stay safe.</tt:p>
    </tt:div>
  </tt:body>
</tt:tt>
`;
