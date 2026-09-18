/**
 * Auto / light / dark, cycled from one button.
 *
 * Dark mode themes the CHROME ONLY. Nothing here touches --paper or --ink for the
 * page: app.css redefines the chrome tokens and leaves the page alone, and the page
 * is lifted off the dark ground by a warm shadow and an edge vignette rather than by
 * dimming the paper. A photo-negative page destroys the thing the product sells.
 */

export type ThemeChoice = 'auto' | 'light' | 'dark';

const KEY = 'ah.theme';
const ORDER: readonly ThemeChoice[] = ['auto', 'light', 'dark'];

export function nextChoice(current: ThemeChoice): ThemeChoice {
  const index = ORDER.indexOf(current);
  return ORDER[(index + 1) % ORDER.length] ?? 'auto';
}

export function readChoice(): ThemeChoice {
  const attribute = document.documentElement.dataset['theme'];
  return attribute === 'light' || attribute === 'dark' ? attribute : 'auto';
}

export function applyChoice(choice: ThemeChoice): void {
  if (choice === 'auto') delete document.documentElement.dataset['theme'];
  else document.documentElement.dataset['theme'] = choice;
  try {
    if (choice === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch (err) {
    // Not swallowed: the choice will not survive a reload and the user should know
    // why rather than assume the button is broken.
    console.error('could not persist the theme choice', err);
  }
}

const LABEL: Record<ThemeChoice, string> = { auto: 'Auto', light: 'Light', dark: 'Dark' };
const ARIA: Record<ThemeChoice, string> = {
  auto: 'Theme: follow the system. Activate for light.',
  light: 'Theme: light. Activate for dark.',
  dark: 'Theme: dark. Activate to follow the system.',
};

export function wireThemeToggle(button: HTMLButtonElement, label: HTMLElement): void {
  const paint = (choice: ThemeChoice): void => {
    label.textContent = LABEL[choice];
    button.setAttribute('aria-label', ARIA[choice]);
  };
  paint(readChoice());
  button.addEventListener('click', () => {
    const choice = nextChoice(readChoice());
    applyChoice(choice);
    paint(choice);
  });
}
