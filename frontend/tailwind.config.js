/** @type {import('tailwindcss').Config} */

// ── AARIS design-language palette (see aaris-design-language.md §4) ───────────
// The app was authored against stock Tailwind color names (gray/blue/red/…).
// Rather than hand-edit ~1300 utility classes across 30 files, we remap those
// stock names onto the AARIS tokens here, so every existing component adopts
// the operator-console look at once: near-black surfaces, a single orange
// action accent, and green/amber/red reserved strictly for status.

// Neutral ramp — cool near-black surfaces up to a soft off-white ink.
const neutral = {
  50:  '#f2f4f6',
  100: '#e9ecef', // --ink
  200: '#c7ccd3',
  300: '#a2a9b3',
  400: '#8b939e', // --muted
  500: '#646c77',
  600: '#4d545e', // --dim
  700: '#232830', // --line
  800: '#171b21', // raised hover surface / soft border
  900: '#12151a', // --bg-raise (cards, panels)
  950: '#0e1014', // --bg (page)
};

// Accent ramp — orange is the one and only action color. Every "brand/action"
// family the app used (blue/indigo/violet/purple/sky/cyan/teal) folds to this
// so the UI stays low-noise: orange reads as a signal light, not decoration.
const accent = {
  50:  '#fff2ec',
  100: '#ffe1d3',
  200: '#ffc4a3',
  300: '#ffab82',
  400: '#ff8a55', // links / icons on dark
  500: '#ff7a44', // --accent-hover (button hover fill)
  600: '#ff5a1f', // --accent (primary fill, active states)
  700: '#e04a12',
  800: '#b83c0f',
  900: '#7a280a',
  950: '#3a1305',
};

// Status ramps — kept as distinct hues because AARIS uses them for LEDs/state.
const danger = {
  50: '#fdecec', 100: '#f9d0d1', 200: '#f4a1a3', 300: '#ee7a7d',
  400: '#e5484d', 500: '#e5484d', 600: '#d13438', 700: '#a62a2d',
  800: '#5c1a1c', 900: '#3a1416', 950: '#220c0d',
};
const ok = {
  50: '#e7fbef', 100: '#c4f4d6', 200: '#8fe9b6', 300: '#63e29c',
  400: '#3fd97f', 500: '#3fd97f', 600: '#2fb968', 700: '#248f50',
  800: '#164d2e', 900: '#0f3320', 950: '#081a10',
};
const warning = {
  50: '#fff6e6', 100: '#ffe9bf', 200: '#ffd47a', 300: '#ffc352',
  400: '#ffb224', 500: '#ffb224', 600: '#e09a12', 700: '#a8730d',
  800: '#5c400a', 900: '#3a2906', 950: '#1f1603',
};

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        white: '#e9ecef',   // AARIS: never pure white
        black: '#0e1014',   // AARIS: never pure black
        // neutrals
        gray: neutral,
        slate: neutral,
        zinc: neutral,
        neutral,
        stone: neutral,
        // action → orange accent
        blue: accent,
        indigo: accent,
        violet: accent,
        purple: accent,
        fuchsia: accent,
        sky: accent,
        cyan: accent,
        teal: accent,
        orange: accent,
        amber: warning,
        yellow: warning,
        green: ok,
        emerald: ok,
        lime: ok,
        red: danger,
        rose: danger,
        // named AARIS tokens for hand-written components
        ink: '#e9ecef',
        muted: '#8b939e',
        dim: '#4d545e',
        line: '#232830',
        'line-soft': '#1a1e25',
        raise: '#12151a',
        accent: accent[600],
      },
      fontFamily: {
        sans: ['Archivo', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        // Machined look — square everything except genuinely round things
        // (spinners, LED dots, avatars keep `rounded-full`).
        none: '0',
        sm: '0',
        DEFAULT: '0',
        md: '0',
        lg: '0',
        xl: '0',
        '2xl': '0',
        '3xl': '0',
        full: '9999px',
      },
      boxShadow: {
        // AARIS: thin borders over heavy shadows.
        none: 'none',
        sm: 'none',
        DEFAULT: 'none',
        md: 'none',
        lg: 'none',
        xl: 'none',
        '2xl': 'none',
        inner: 'none',
      },
    },
  },
  plugins: [],
};
