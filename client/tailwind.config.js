/** @type {import('tailwindcss').Config} */
import tailwindcssAnimate from 'tailwindcss-animate';

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Manrope', 'ui-sans-serif', 'system-ui'],
        display: ['Fraunces', 'serif']
      },
      colors: {
        surface: {
          DEFAULT: '#f6f2ed',
          strong: '#efe7dd'
        },
        ink: {
          DEFAULT: '#1b1a1a',
          muted: '#5d5753'
        },
        brand: {
          DEFAULT: '#d36b2d',
          dark: '#9a461b'
        },
        highlight: '#f7c86b',
        destructive: {
          DEFAULT: '#dc2626',
          foreground: '#ffffff'
        },
        muted: {
          DEFAULT: '#f3f4f6',
          foreground: '#6b7280'
        },
        border: '#e5e7eb',
        foreground: '#1b1a1a',
        background: '#f6f2ed'
      },
      boxShadow: {
        soft: '0 12px 40px -20px rgba(31, 23, 17, 0.35)'
      },
      borderRadius: {
        xl: '1.25rem'
      }
    }
  },
  plugins: [tailwindcssAnimate]
};
