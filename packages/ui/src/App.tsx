import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { SettingsDialog } from "@/components/SettingsDialog";
import { Transformers } from "@/components/Transformers";
import { Providers } from "@/components/Providers";
import { Router } from "@/components/Router";
import { JsonEditor } from "@/components/JsonEditor";
import { LogViewer } from "@/components/LogViewer";
import { UsageStats } from "@/components/UsageStats";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/components/ConfigProvider";
import { api } from "@/lib/api";
import { Settings, Save, RefreshCw } from "lucide-react";
import { Toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import "@/styles/animations.css";

function App() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { config, error } = useConfig();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isJsonEditorOpen, setIsJsonEditorOpen] = useState(false);
  const [isLogViewerOpen, setIsLogViewerOpen] = useState(false);
  const [isUsageStatsOpen, setIsUsageStatsOpen] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'warning' } | null>(null);
  const [isNewVersionAvailable, setIsNewVersionAvailable] = useState(false);
  const [isUpdateDialogOpen, setIsUpdateDialogOpen] = useState(false);
  const [newVersionInfo, setNewVersionInfo] = useState<{ version: string; changelog: string } | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [hasCheckedUpdate, setHasCheckedUpdate] = useState(false);
  const [isUpdateFeatureAvailable, setIsUpdateFeatureAvailable] = useState(true);
  const hasAutoCheckedUpdate = useRef(false);

  const saveConfig = async () => {
    if (!config) {
      setToast({ message: t('app.config_missing'), type: 'error' });
      return;
    }
    try {
      const response = await api.updateConfig(config);
      if (response.success) {
        setToast({ message: response.message || t('app.config_saved_success'), type: 'success' });
      } else {
        setToast({ message: response.message || t('app.config_saved_failed'), type: 'error' });
      }
    } catch (error) {
      console.error('Failed to save config:', error);
      setToast({ message: t('app.config_saved_failed') + ': ' + (error as Error).message, type: 'error' });
    }
  };

  const saveConfigAndRestart = async () => {
    if (!config) {
      setToast({ message: t('app.config_missing'), type: 'error' });
      return;
    }
    try {
      const response = await api.updateConfig(config);
      if (!response.success) {
        setToast({ message: response.message || t('app.config_saved_failed'), type: 'error' });
        return;
      }
      const restartResponse = await api.restartService();
      if (restartResponse && typeof restartResponse === 'object' && 'success' in restartResponse) {
        const apiResponse = restartResponse as { success: boolean; message?: string };
        if (apiResponse.success) {
          setToast({ message: apiResponse.message || t('app.config_saved_restart_success'), type: 'success' });
        }
      } else {
        setToast({ message: t('app.config_saved_restart_success'), type: 'success' });
      }
    } catch (error) {
      console.error('Failed to save config and restart:', error);
      setToast({ message: t('app.config_saved_restart_failed') + ': ' + (error as Error).message, type: 'error' });
    }
  };

  const checkForUpdates = useCallback(async (showDialog: boolean = true) => {
    if (hasCheckedUpdate && isNewVersionAvailable) {
      if (showDialog) setIsUpdateDialogOpen(true);
      return;
    }
    setIsCheckingUpdate(true);
    try {
      const updateInfo = await api.checkForUpdates();
      if (updateInfo.hasUpdate && updateInfo.latestVersion && updateInfo.changelog) {
        setIsNewVersionAvailable(true);
        setNewVersionInfo({ version: updateInfo.latestVersion, changelog: updateInfo.changelog });
        if (showDialog) setIsUpdateDialogOpen(true);
      } else if (showDialog) {
        setToast({ message: t('app.no_updates_available'), type: 'success' });
      }
      setHasCheckedUpdate(true);
    } catch (error) {
      console.error('Failed to check for updates:', error);
      setIsUpdateFeatureAvailable(false);
      if (showDialog) {
        setToast({ message: t('app.update_check_failed') + ': ' + (error as Error).message, type: 'error' });
      }
    } finally {
      setIsCheckingUpdate(false);
    }
  }, [hasCheckedUpdate, isNewVersionAvailable, t]);

  useEffect(() => {
    const checkAuth = async () => {
      if (config) {
        setIsCheckingAuth(false);
        if (!hasCheckedUpdate && !hasAutoCheckedUpdate.current) {
          hasAutoCheckedUpdate.current = true;
          checkForUpdates(false);
        }
        return;
      }
      const apiKey = localStorage.getItem('apiKey');
      if (!apiKey) {
        setIsCheckingAuth(false);
        return;
      }
      try {
        await api.getConfig();
      } catch (err) {
        console.error('Error checking auth:', err);
        if ((err as Error).message === 'Unauthorized') {
          navigate('/login');
        }
      } finally {
        setIsCheckingAuth(false);
        if (!hasCheckedUpdate && !hasAutoCheckedUpdate.current) {
          hasAutoCheckedUpdate.current = true;
          checkForUpdates(false);
        }
      }
    };
    checkAuth();

    const handleUnauthorized = () => navigate('/login');
    window.addEventListener('unauthorized', handleUnauthorized);
    return () => window.removeEventListener('unauthorized', handleUnauthorized);
  }, [config, navigate, hasCheckedUpdate, checkForUpdates]);

  const performUpdate = async () => {
    if (!newVersionInfo) return;
    try {
      const result = await api.performUpdate();
      if (result.success) {
        setToast({ message: t('app.update_successful'), type: 'success' });
        setIsNewVersionAvailable(false);
        setIsUpdateDialogOpen(false);
        setHasCheckedUpdate(false);
      } else {
        setToast({ message: t('app.update_failed') + ': ' + result.message, type: 'error' });
      }
    } catch (error) {
      console.error('Failed to perform update:', error);
      setToast({ message: t('app.update_failed') + ': ' + (error as Error).message, type: 'error' });
    }
  };

  if (isCheckingAuth) {
    return (
      <div className="h-screen bg-gray-50 font-sans flex items-center justify-center">
        <div className="text-gray-500">Loading application...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen bg-gray-50 font-sans flex items-center justify-center">
        <div className="text-red-500">Error: {error.message}</div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="h-screen bg-gray-50 font-sans flex items-center justify-center">
        <div className="text-gray-500">Loading configuration...</div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="h-screen bg-gray-50 font-sans">
      <header className="flex h-16 items-center justify-between border-b bg-white px-6">
        <h1 className="text-xl font-semibold text-gray-800">{t('app.title')}</h1>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={() => setIsSettingsOpen(true)}>
                <Settings className="h-5 w-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('app.settings')}</p>
            </TooltipContent>
          </Tooltip>
          <Button onClick={saveConfig} variant="outline">
            <Save className="mr-2 h-4 w-4" />
            {t('app.save')}
          </Button>
          <Button onClick={saveConfigAndRestart}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {t('app.save_and_restart')}
          </Button>
        </div>
      </header>
      <main className="flex flex-col h-[calc(100vh-4rem)] gap-4 p-4 overflow-hidden">
        <div className="flex gap-4 flex-1 min-h-0">
          <div className="w-3/5">
            <Providers />
          </div>
          <div className="flex w-2/5 flex-col gap-4">
            <div className="h-3/5">
              <Router />
            </div>
            <div className="flex-1 overflow-hidden">
              <Transformers />
            </div>
          </div>
        </div>
      </main>
      <SettingsDialog
        isOpen={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
        onOpenJsonEditor={() => setIsJsonEditorOpen(true)}
        onOpenLogViewer={() => setIsLogViewerOpen(true)}
        onOpenUsageStats={() => setIsUsageStatsOpen(true)}
        onCheckUpdates={() => checkForUpdates(true)}
        isCheckingUpdate={isCheckingUpdate}
        onUpdateAvailable={isNewVersionAvailable}
      />
      <JsonEditor
        open={isJsonEditorOpen}
        onOpenChange={setIsJsonEditorOpen}
        showToast={(message, type) => setToast({ message, type })}
      />
      <LogViewer
        open={isLogViewerOpen}
        onOpenChange={setIsLogViewerOpen}
        showToast={(message, type) => setToast({ message, type })}
      />
      <Dialog open={isUsageStatsOpen} onOpenChange={setIsUsageStatsOpen}>
        <DialogContent className="max-w-5xl h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>{t('usage.title')}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1">
            <UsageStats />
          </div>
        </DialogContent>
      </Dialog>
      {/* Update dialog */}
      <Dialog open={isUpdateDialogOpen} onOpenChange={setIsUpdateDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t('app.new_version_available')}
              {newVersionInfo && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  v{newVersionInfo.version}
                </span>
              )}
            </DialogTitle>
            <DialogDescription>
              {t('app.update_description')}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-96 overflow-y-auto py-4">
            {newVersionInfo?.changelog ? (
              <div className="whitespace-pre-wrap text-sm">
                {newVersionInfo.changelog}
              </div>
            ) : (
              <div className="text-muted-foreground">
                {t('app.no_changelog_available')}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsUpdateDialogOpen(false)}>
              {t('app.later')}
            </Button>
            <Button onClick={performUpdate}>
              {t('app.update_now')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </div>
    </TooltipProvider>
  );
}

export default App;
