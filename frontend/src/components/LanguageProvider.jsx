import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { getUser } from "../lib/auth";
import { getLanguage, isSupportedLanguage, saveLanguage, translate } from "../lib/language";

const LanguageContext = createContext(null);

function getInitialLanguage(user) {
  // Language preferences are user-specific. Do not let the last language
  // selected by another account silently become this account's locale.
  if (user?.id) {
    const stored = localStorage.getItem(`parakh_language_${user.id}`);
    return isSupportedLanguage(stored) ? stored : "en";
  }
  return getLanguage();
}

export function LanguageProvider({ children }) {
  const user = getUser();
  const [language, setLanguageState] = useState(() => getInitialLanguage(user));

  useEffect(() => {
    saveLanguage(language, getUser()?.id);
  }, [language]);

  const value = useMemo(() => ({
    language,
    setLanguage(next) {
      setLanguageState(saveLanguage(next, getUser()?.id));
    },
    t(key) { return translate(language, key); },
  }), [language]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used inside LanguageProvider");
  return context;
}
