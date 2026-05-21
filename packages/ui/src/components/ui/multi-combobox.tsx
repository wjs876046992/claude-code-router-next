"use client"

import * as React from "react"
import { Check, ChevronsUpDown, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"

interface MultiComboboxProps {
  options: { label: string; value: string }[];
  value?: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyPlaceholder?: string;
}

export function MultiCombobox({
  options,
  value = [],
  onChange,
  placeholder = "Select options...",
  searchPlaceholder = "Search...",
  emptyPlaceholder = "No options found.",
}: MultiComboboxProps) {
  const [open, setOpen] = React.useState(false)
  const [draggedIndex, setDraggedIndex] = React.useState<number | null>(null);
  
  const handleSelect = (currentValue: string) => {
    if (value.includes(currentValue)) {
      onChange(value.filter(v => v !== currentValue))
    } else {
      onChange([...value, currentValue])
    }
  }
  
  const removeValue = (val: string, e: React.MouseEvent) => {
    e.stopPropagation()
    onChange(value.filter(v => v !== val))
  }

  const handleDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.effectAllowed = "move";
    setDraggedIndex(index);
    // Needed for Firefox
    e.dataTransfer.setData("text/plain", index.toString());
  };

  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === targetIndex) return;
    
    const newValue = [...value];
    const [draggedItem] = newValue.splice(draggedIndex, 1);
    newValue.splice(targetIndex, 0, draggedItem);
    onChange(newValue);
    setDraggedIndex(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {value.map((val, index) => {
          const option = options.find(opt => opt.value === val)
          return (
            <Badge 
              key={val} 
              variant="secondary" 
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              className={`text-xs font-medium py-1 px-2.5 rounded-md flex items-center bg-blue-50/80 hover:bg-blue-50 border border-blue-100 text-blue-800 dark:bg-blue-950/40 dark:border-blue-900/50 dark:text-blue-300 transition-all shadow-sm cursor-grab active:cursor-grabbing ${draggedIndex === index ? 'opacity-50 border-dashed' : ''}`}
            >
              <span className="truncate max-w-[250px]">{option?.label || val}</span>
              <button
                onClick={(e) => removeValue(val, e)}
                className="ml-1.5 p-0.5 rounded-full hover:bg-blue-100 dark:hover:bg-blue-900/60 text-blue-600/80 dark:text-blue-400/80 hover:text-blue-900 dark:hover:text-blue-200 transition-colors"
                title="Remove"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </Badge>
          )
        })}
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between transition-all-ease hover:scale-[1.02] active:scale-[0.98]"
          >
            {value.length > 0 ? `${value.length} selected` : placeholder}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50 transition-transform duration-200 group-data-[state=open]:rotate-180" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0 animate-fade-in">
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>{emptyPlaceholder}</CommandEmpty>
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    onSelect={() => handleSelect(option.value)}
                    className="transition-all-ease hover:bg-accent hover:text-accent-foreground"
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4 transition-opacity",
                        value.includes(option.value) ? "opacity-100" : "opacity-0"
                      )}
                    />
                    {option.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}