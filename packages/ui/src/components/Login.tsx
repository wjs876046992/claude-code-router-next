import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { Background } from '@/components/ui/Background';
import { ShieldCheck, ArrowRight, Lock } from 'lucide-react';

export function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const checkAuth = async () => {
      const apiKey = localStorage.getItem('apiKey');
      if (apiKey) {
        setIsLoading(true);
        try {
          await api.getConfig();
          navigate('/dashboard');
        } catch {
          localStorage.removeItem('apiKey');
        } finally {
          setIsLoading(false);
        }
      }
    };

    checkAuth();
    
    const handleUnauthorized = () => {
      navigate('/login');
    };
    
    window.addEventListener('unauthorized', handleUnauthorized);
    return () => {
      window.removeEventListener('unauthorized', handleUnauthorized);
    };
  }, [navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      api.setApiKey(apiKey);
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'apiKey',
        newValue: apiKey,
        url: window.location.href
      }));
      await api.getConfig();
      navigate('/dashboard');
    } catch (error: any) {
      api.setApiKey('');
      if (error.message && error.message.includes('401')) {
        setError(t('login.invalidApiKey'));
      } else {
        navigate('/dashboard');
      }
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6 bg-background relative overflow-hidden">
      <Background />
      
      <div className="w-full max-w-md animate-in relative z-10">
        <div className="flex flex-col items-center mb-10 text-center">
          <div className="p-4 bg-primary/10 rounded-3xl mb-4 border border-primary/20 shadow-xl shadow-primary/10">
            <ShieldCheck className="h-10 w-10 text-primary" />
          </div>
          <h1 className="text-4xl font-bold tracking-tight mb-2 bg-gradient-to-b from-foreground to-foreground/60 bg-clip-text text-transparent">
            {t('app.title')}
          </h1>
          <p className="text-muted-foreground font-medium">{t('login.description')}</p>
        </div>

        <Card className="glass-card border-white/10 shadow-2xl rounded-3xl overflow-hidden">
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-2xl font-bold flex items-center gap-2">
              <Lock className="h-5 w-5 text-primary" />
              {t('login.title')}
            </CardTitle>
          </CardHeader>
          <form onSubmit={handleLogin}>
            <CardContent className="space-y-6 pt-2">
              <div className="space-y-3">
                <Label htmlFor="apiKey" className="text-sm font-semibold ml-1">
                  {t('login.apiKey')}
                </Label>
                <div className="relative group">
                  <Input
                    id="apiKey"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={t('login.apiKeyPlaceholder')}
                    className="h-12 bg-white/5 border-white/10 rounded-xl px-4 focus:ring-primary/50 transition-all group-hover:bg-white/10"
                    required
                  />
                </div>
              </div>
              {error && (
                <div className="p-3 bg-destructive/10 border border-destructive/20 text-destructive text-sm rounded-xl animate-in">
                  {error}
                </div>
              )}
            </CardContent>
            <CardFooter className="pt-2 pb-8">
              <Button 
                className="w-full h-12 rounded-xl text-lg font-semibold shadow-lg shadow-primary/20 bg-primary hover:bg-primary/90 hover:scale-[1.02] active:scale-[0.98] transition-all" 
                type="submit"
                disabled={isLoading}
              >
                {isLoading ? (
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                ) : (
                  <>
                    {t('login.signIn')}
                    <ArrowRight className="ml-2 h-5 w-5" />
                  </>
                )}
              </Button>
            </CardFooter>
          </form>
        </Card>
        
        <p className="mt-8 text-center text-sm text-muted-foreground/60">
          © 2024 Claude Code Router. Premium Routing Experience.
        </p>
      </div>
    </div>
  );
}