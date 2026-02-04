import React from 'react';

const THEME_KEY = 'wnb-theme';

const getStoredTheme = () => {
  if (typeof window === 'undefined') return null;
  const value = window.localStorage.getItem(THEME_KEY);
  return value === 'light' || value === 'dark' ? value : null;
};

const getSystemTheme = () => {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const applyThemeClass = (theme) => {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', theme === 'dark');
};

const ThemeContext = React.createContext({
  theme: 'light',
  setTheme: () => {},
  toggleTheme: () => {}
});

const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = React.useState(() => {
    const resolved = getStoredTheme() || getSystemTheme();
    applyThemeClass(resolved);
    return resolved;
  });

  React.useEffect(() => {
    applyThemeClass(theme);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_KEY, theme);
    }
  }, [theme]);

  const toggleTheme = React.useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  const value = React.useMemo(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, toggleTheme]
  );

  return React.createElement(ThemeContext.Provider, { value }, children);
};

const useTheme = () => React.useContext(ThemeContext);

export { ThemeProvider, useTheme };
