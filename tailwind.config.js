/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
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
