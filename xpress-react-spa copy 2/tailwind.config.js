/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        "surface": "#faf6f0",
        "surface-container": "#f0ece4",
        "surface-container-low": "#f5f1ea",
        "surface-container-lowest": "#ffffff",
        "surface-container-high": "#eae6de",
        "surface-container-highest": "#e4e0d8",
        "surface-variant": "#e4e0d8",
        "on-surface": "#2e3230",
        "on-surface-variant": "#4a4e4a",
        "primary": "#4a7c59",
        "on-primary": "#ffffff",
        "primary-container": "#78a886",
        "on-primary-container": "#d8f0de",
        "inverse-primary": "#8ecf9e",
        "secondary": "#6b6358",
        "on-secondary": "#ffffff",
        "tertiary": "#705c30",
        "on-tertiary": "#ffffff",
        "tertiary-container": "#c4a66a",
        "outline": "#74796e",
        "outline-variant": "#c4c8bc",
        "error": "#b83230",
        "on-error": "#ffffff",
        "error-container": "#ffdad8",
        "background": "#faf6f0",
        "on-background": "#2e3230",
      },
      fontFamily: {
        "headline": ["Literata", "serif"],
        "body": ["Nunito Sans", "sans-serif"],
        "label": ["Nunito Sans", "sans-serif"]
      }
    },
  },
  plugins: [],
}
