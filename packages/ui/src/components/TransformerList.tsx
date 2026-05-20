import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Transformer } from "@/types";

interface TransformerListProps {
  transformers: Transformer[];
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
}

export function TransformerList({ transformers, onEdit, onRemove }: TransformerListProps) {
  if (!transformers || !Array.isArray(transformers)) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 p-12 text-muted-foreground animate-in">
          No transformers configured
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {transformers.map((transformer, index) => {
        if (!transformer) return null;

        const transformerPath = transformer.path || "Unnamed Transformer";
        const options = transformer.options || {};
        
        const renderParameters = () => {
          if (!options || Object.keys(options).length === 0) {
            return <p className="text-xs text-muted-foreground/40 italic">No parameters configured</p>;
          }
          
          return (
            <div className="flex flex-wrap gap-2">
              {Object.entries(options).map(([key, value]) => (
                <span 
                  key={key} 
                  className="inline-flex items-center px-2 py-0.5 rounded-lg bg-white/5 text-[10px] font-bold text-muted-foreground border border-white/5"
                >
                  <span className="text-muted-foreground/60">{key}:</span>
                  <span className="ml-1 text-primary">{String(value)}</span>
                </span>
              ))}
            </div>
          );
        };

        return (
          <div key={index} className="flex items-start justify-between rounded-2xl border border-white/10 bg-white/5 p-5 transition-all hover:bg-white/10 hover:border-primary/30 group animate-in shadow-lg shadow-black/5">
            <div className="flex-1 space-y-3">
              <p className="text-base font-bold tracking-tight text-foreground">{transformerPath}</p>
              {renderParameters()}
            </div>
            <div className="ml-4 flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <Button variant="ghost" size="icon" onClick={() => onEdit(index)} className="h-9 w-9 rounded-lg hover:bg-primary/20 hover:text-primary">
                <Pencil className="h-4 w-4" />
              </Button>
              <Button variant="destructive" size="icon" onClick={() => onRemove(index)} className="h-9 w-9 rounded-lg opacity-80 hover:opacity-100">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
