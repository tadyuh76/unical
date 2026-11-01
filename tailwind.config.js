/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Named colours (globals.css).
      colors: Object.fromEntries(
        ["page", "ink", "muted", "faint", "soft", "raised", "line", "track", "brand", "brand-soft", "warn", "warn-bg", "warn-ink", "danger", "signin"]
          .map((name) => [name, `rgb(var(--${name}) / <alpha-value>)`])
          .concat([["edge", "var(--edge)"]])
      ),
      boxShadow: { lift: "var(--lift)" },
      keyframes: {
        bob: {
          "0%, 100%": { transform: "translateY(0) rotate(0deg)" },
          "50%": { transform: "translateY(-3px) rotate(-2deg)" },
        },
      },
      animation: {
        bob: "bob 3.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
