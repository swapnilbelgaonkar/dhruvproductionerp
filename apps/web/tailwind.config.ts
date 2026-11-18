import type { Config } from 'tailwindcss';

// Tokens from docs/pre-development/10-ui-design-system.md (incl. accessibility corrections U6/U7 and reference-image samples)
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: '#5B38F5', hover: '#4931D4', alt: '#6847FF', soft: '#EEEAFE', tint: '#F5F2FF' },
        canvas: { DEFAULT: '#F6F8FE', alt: '#F5F4FB' },
        ink: { DEFAULT: '#171729', 2: '#6B6B80', muted: '#B5B4C4' },
        line: { DEFAULT: '#EEEFF5', input: '#D9D9E3' },
        success: { DEFAULT: '#5DD6A0', bg: '#ECFBF4', text: '#177A4D' },
        danger: { DEFAULT: '#F16A91', bg: '#FFF0F4', text: '#B42354' },
        warning: { DEFAULT: '#F5A524', bg: '#FFF4E5', text: '#9A4A08' },
        info: { DEFAULT: '#3B82F6', bg: '#EAF2FF', text: '#2563C9' },
        neutral: { bg: '#F3F3F7', text: '#5E5E73' },
        accent: '#E639CF',
        chart: { neutral: '#DED9E8', track: '#E9E8F0' },
      },
      fontFamily: {
        sans: ['Inter', '"SF Pro Text"', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        display: ['"Plus Jakarta Sans"', 'Inter', 'sans-serif'],
      },
      borderRadius: { sm: '10px', md: '14px', lg: '18px', xl: '24px', '2xl': '30px' },
      boxShadow: {
        card: '0 8px 30px rgba(41,38,80,0.04)',
        hover: '0 12px 36px rgba(41,38,80,0.08)',
        primary: '0 10px 24px rgba(91,56,245,0.25)',
        focus: '0 0 0 3px rgba(91,56,245,0.25)',
      },
      transitionTimingFunction: { erp: 'cubic-bezier(0.4,0,0.2,1)' },
    },
  },
  plugins: [],
} satisfies Config;
