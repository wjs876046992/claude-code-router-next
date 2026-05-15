import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { UsageStats } from "@/components/UsageStats";

export function UsageStatsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="h-screen bg-gray-50">
      <header className="flex h-16 items-center border-b bg-white px-6">
        <Button variant="ghost" size="sm" onClick={() => navigate('/settings')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('advanced_router.back')}
        </Button>
        <h1 className="text-xl font-semibold text-gray-800 ml-4">{t('usage.title')}</h1>
      </header>
      <main className="h-[calc(100vh-4rem)] p-6">
        <UsageStats />
      </main>
    </div>
  );
}