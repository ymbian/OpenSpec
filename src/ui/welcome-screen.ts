/**
 * Animated welcome screen for the experimental artifact workflow setup.
 * Shows side-by-side layout with animated ASCII art on left and welcome text on right.
 */

import chalk from 'chalk';
import { WELCOME_ANIMATION } from './ascii-patterns.js';

// Minimum terminal width for side-by-side layout
const MIN_WIDTH = 60;

// Width of the ASCII art column (with padding)
const ART_COLUMN_WIDTH = 24;

/**
 * Welcome text content (right column)
 */
function getWelcomeText(): string[] {
  return [
    chalk.white.bold('Welcome to InfraSpec'),
    chalk.dim('A lightweight spec-driven framework'),
    '',
    chalk.white('This setup will configure:'),
    chalk.dim('  • Agent Skills for AI tools'),
    chalk.dim('  • /infra:* slash commands'),
    '',
    chalk.white('Quick start after setup:'),
    `  ${chalk.yellow('/infra:new')}      ${chalk.dim('Create a change')}`,
    `  ${chalk.yellow('/infra:continue')} ${chalk.dim('Next artifact')}`,
    `  ${chalk.yellow('/infra:apply')}    ${chalk.dim('Implement tasks')}`,
    '',
    chalk.cyan('Press Enter to select tools...'),
  ];
}

/**
 * Renders a single frame with side-by-side layout
 */
function renderFrame(artLines: string[], textLines: string[]): string {
  const maxLines = Math.max(artLines.length, textLines.length);
  const lines: string[] = [];

  for (let i = 0; i < maxLines; i++) {
    const artLine = artLines[i] || '';
    const textLine = textLines[i] || '';

    // Pad the art column to fixed width
    const paddedArt = artLine.padEnd(ART_COLUMN_WIDTH);

    // Color the ASCII art with cyan for visual appeal
    const coloredArt = chalk.cyan(paddedArt);

    // Clear line before writing to prevent residual characters
    lines.push(`\x1b[2K${coloredArt}${textLine}`);
  }

  return lines.join('\n');
}

/**
 * Checks if the terminal supports animation
 */
function canAnimate(): boolean {
  // Must be TTY
  if (!process.stdout.isTTY) return false;

  // Respect NO_COLOR
  if (process.env.NO_COLOR) return false;

  // Check terminal width
  const columns = process.stdout.columns || 80;
  if (columns < MIN_WIDTH) return false;

  return true;
}

/**
 * Wait for Enter key press
 */
function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const { stdin } = process;

    // Handle non-TTY gracefully
    if (!stdin.isTTY) {
      resolve();
      return;
    }

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    const onData = (data: Buffer): void => {
      const char = data.toString();

      // Enter key or Ctrl+C
      if (char === '\r' || char === '\n' || char === '\u0003') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(wasRaw);
        stdin.pause();

        // Handle Ctrl+C
        if (char === '\u0003') {
          process.stdout.write('\n');
          process.exit(0);
        }

        resolve();
      }
    };

    stdin.on('data', onData);
  });
}

/**
 * Shows the animated welcome screen.
 * Returns when user presses Enter.
 */
export async function showWelcomeScreen(): Promise<void> {
  const textLines = getWelcomeText();

  if (!canAnimate()) {
    const artFrame = WELCOME_ANIMATION.frames[0];
    process.stdout.write('\n' + renderFrame(artFrame, textLines) + '\n\n');
    await waitForEnter();
    return;
  }

  // Static welcome: render once, no animation loop
  const artFrame = WELCOME_ANIMATION.frames[0];
  process.stdout.write('\n' + renderFrame(artFrame, textLines) + '\n\n');
  await waitForEnter();

  // Clear the welcome screen and move on
  const numContentLines = Math.max(artFrame.length, textLines.length);
  const totalHeight = numContentLines + 2;
  process.stdout.write(`\x1b[${totalHeight}A`);
  for (let i = 0; i < totalHeight; i++) {
    process.stdout.write('\x1b[2K\n');
  }
  process.stdout.write(`\x1b[${totalHeight}A`);
}
