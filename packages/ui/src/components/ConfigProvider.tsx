import { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode, Dispatch, SetStateAction } from 'react';
import { api } from '@/lib/api';
import type { Config, StatusLineConfig } from '@/types';

interface ConfigContextType {
  config: Config | null;
  setConfig: Dispatch<SetStateAction<Config | null>>;
  error: Error | null;
}

const ConfigContext = createContext<ConfigContextType | undefined>(undefined);

// eslint-disable-next-line react-refresh/only-export-components
export function useConfig() {
  const context = useContext(ConfigContext);
  if (context === undefined) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
}

interface ConfigProviderProps {
  children: ReactNode;
}

export function ConfigProvider({ children }: ConfigProviderProps) {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [hasFetched, setHasFetched] = useState<boolean>(false);
  const [apiKey, setApiKey] = useState<string | null>(localStorage.getItem('apiKey'));

  // Listen for localStorage changes
  useEffect(() => {
    const handleStorageChange = () => {
      setApiKey(localStorage.getItem('apiKey'));
    };

    window.addEventListener('storage', handleStorageChange);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  useEffect(() => {
    const fetchConfig = async () => {
      // Reset fetch state when API key changes
      setHasFetched(false);
      setConfig(null);
      setError(null);
    };

    fetchConfig();
  }, [apiKey]);

  useEffect(() => {
    const fetchConfig = async () => {
      // Prevent duplicate API calls in React StrictMode
      // Skip if we've already fetched
      if (hasFetched) {
        return;
      }
      setHasFetched(true);
      
      try {
        // Try to fetch config regardless of API key presence
        const data = await api.getConfig();

        // Pass through the raw server data as-is so we never write back
        // fields that the user didn't configure. Components handle missing
        // fields with defensive defaults at render time.
        const validConfig = { ...data } as Config;

        // Only normalise nested structures that the UI mutates directly
        if (data.Providers && !Array.isArray(data.Providers)) {
          validConfig.Providers = [];
        }
        if (data.transformers && !Array.isArray(data.transformers)) {
          validConfig.transformers = [];
        }
        
        setConfig(validConfig);
      } catch (err) {
        console.error('Failed to fetch config:', err);
        // If we get a 401, the API client will redirect to login
        // Otherwise, set an empty config or error
        if ((err as Error).message !== 'Unauthorized') {
          // Set default empty config when fetch fails
          setConfig({
            LOG: false,
            LOG_LEVEL: 'debug',
            CLAUDE_PATH: '',
            HOST: '127.0.0.1',
            PORT: 3456,
            APIKEY: '',
            API_TIMEOUT_MS: '600000',
            PROXY_URL: '',
            transformers: [],
            Providers: [],
            StatusLine: undefined,
            Clients: {
              claudeCode: {
                enabled: false,
                managed: false,
                configPath: '~/.claude/settings.json',
              },
              codex: {
                enabled: false,
                managed: false,
                configPath: '~/.codex/config.toml',
                modelAlias: 'ccr-codex',
              },
            },
            Router: {
              default: '',
              background: '',
              think: '',
              longContext: '',
              longContextThreshold: 60000,
              webSearch: '',
              image: '',
              models: {}
            },
            CUSTOM_ROUTER_PATH: ''
          });
          setError(err as Error);
        }
      }
    };

    fetchConfig();
  }, [hasFetched, apiKey]);

  return (
    <ConfigContext.Provider value={{ config, setConfig, error }}>
      {children}
    </ConfigContext.Provider>
  );
}
