import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [{
  files: ['src/**/*.{js,jsx}'],
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
    globals: { ...globals.browser, ...globals.node },
  },
  plugins: { 'react-hooks': reactHooks },
  rules: {
    'no-undef': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
}];
