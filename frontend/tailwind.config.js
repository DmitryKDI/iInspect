/** Токены визуального языка вынесены в src/theme.ts для быстрой замены. */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        accent: { DEFAULT: '#5B5BD6', hover: '#4A4AC4', soft: '#EEEEFB', line: '#C9C9F0' },
        surface: { DEFAULT: '#FFFFFF', muted: '#F5F6F8', line: '#E3E5EA' },
        ink: { DEFAULT: '#1F2330', muted: '#5B6273', faint: '#8A91A3' },
        critical: { DEFAULT: '#C8324B', soft: '#FCEDF0' },
        major: { DEFAULT: '#C77A16', soft: '#FDF3E4' },
        minor: { DEFAULT: '#3E7C4F', soft: '#EDF6EF' },
      },
      fontFamily: { sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'] },
      boxShadow: { card: '0 1px 2px rgba(31,35,48,.06), 0 1px 3px rgba(31,35,48,.04)' },
      borderRadius: { card: '10px' },
    },
  },
  plugins: [],
}
