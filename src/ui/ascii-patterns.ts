/**
 * ASCII art patterns for the welcome screen.
 * Static INFRA block art only (no animation).
 */

// Detect if full Unicode is supported
const supportsUnicode =
  process.platform !== 'win32' ||
  !!process.env.WT_SESSION || // Windows Terminal
  !!process.env.TERM_PROGRAM; // Modern terminal

const UI = supportsUnicode
  ? {
      h: '─',
      v: '│',
      tl: '┌',
      tr: '┐',
      bl: '└',
      br: '┘',
      glow: '█',
      dot: '•',
      empty: ' ',
    }
  : {
      h: '-',
      v: '|',
      tl: '+',
      tr: '+',
      bl: '+',
      br: '+',
      glow: '#',
      dot: '*',
      empty: ' ',
    };

function pad(line = ''): string {
  return line.padEnd(24, UI.empty);
}

function frame(lines: string[]): string[] {
  return lines.map((line) => pad(line));
}

/** INFRA word as 5-line block art (each letter 3 wide, 5 tall). */
function infraBlockArt(): string[] {
  const g = UI.glow;
  const e = UI.empty;
  return [
    `${g}${g}${g} ${g}${e}${g} ${g}${g}${g} ${g}${g}${g} ${e}${g}${e}`,
    `${e}${g}${e} ${g}${g}${g} ${g}${e}${e} ${g}${e}${g} ${g}${e}${g}`,
    `${e}${g}${e} ${g}${e}${g} ${g}${g}${g} ${g}${g}${g} ${g}${g}${g}`,
    `${e}${g}${e} ${g}${e}${g} ${g}${e}${e} ${g}${e}${g} ${g}${e}${g}`,
    `${g}${g}${g} ${g}${e}${g} ${g}${e}${e} ${g}${e}${g} ${g}${e}${g}`,
  ];
}

const INFRA_LINES = infraBlockArt();
const BOX_TOP = (n: number) => `  ${UI.tl}${UI.h.repeat(n)}${UI.tr}`;
const BOX_BOT = (n: number) => `  ${UI.bl}${UI.h.repeat(n)}${UI.br}`;
const BOX_V = (content: string) => `  ${UI.v} ${content} ${UI.v}`;

/** Content width inside box: INFRA is 19 chars; with spaces and bars total line = 25, so box top/bot = 21. */
const BOX_WIDTH = 21;

/** Single static frame: INFRA in a box (no animation). */
function staticInfraFrame(): string[] {
  const title = ` ${UI.dot} ${UI.glow}${UI.glow}${UI.glow} INFRA SPEC ${UI.glow}${UI.glow}${UI.glow} ${UI.dot}`;
  const titleCentered = UI.empty.repeat(Math.max(0, Math.round((24 - title.length) / 2))) + title;
  return [
    '',
    titleCentered,
    '',
    BOX_TOP(BOX_WIDTH),
    ...INFRA_LINES.map((line) => BOX_V(line)),
    BOX_BOT(BOX_WIDTH),
    '', '', '', '', '',
  ];
}

export const WELCOME_ANIMATION = {
  interval: 0,
  frames: [frame(staticInfraFrame())],
};
