export default {
  plugins: {
    // Tailwind 4 moved the PostCSS plugin out of the `tailwindcss` package.
    // Vendor prefixing and nesting are handled inside this plugin now, so
    // autoprefixer is no longer part of the chain.
    '@tailwindcss/postcss': {},
  },
};
