import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input"> & { disableAutofill?: boolean }>(
  ({ className, type, disableAutofill, ...props }, ref) => {
    const isNumeric = type === "number";
    const [tempValue, setTempValue] = React.useState(props.value?.toString() || '');
    // Randomize the name once per mount so Chrome cannot match this field
    // against previously saved form data (the main source of unwanted autofill).
    const randomName = React.useMemo(
      () => `field-${Math.random().toString(36).slice(2)}`,
      []
    );
    // Start read-only and switch to editable on first focus: read-only fields
    // are skipped by Chrome autofill, defeating it even for re-rendered values.
    const [autofillUnlocked, setAutofillUnlocked] = React.useState(!disableAutofill);

    React.useEffect(() => {
      if (props.value !== undefined) {
        setTempValue(props.value.toString());
      }
    }, [props.value]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;

      if (isNumeric) {
        // Only allow empty string or numbers for numeric input
        if (newValue === '' || /^\d+$/.test(newValue)) {
          setTempValue(newValue);
          // Only call onChange if the value is not empty
          if (props.onChange && newValue !== '') {
            props.onChange(e);
          }
        }
      } else {
        setTempValue(newValue);
        if (props.onChange) {
          props.onChange(e);
        }
      }
    };

    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
      if (isNumeric && tempValue === '') {
        const defaultValue = props.placeholder || "1";
        setTempValue(defaultValue);

        // Create a synthetic event for the corrected value
        if (props.onChange) {
          const syntheticEvent = {
            ...e,
            target: { ...e.target, value: defaultValue }
          } as React.ChangeEvent<HTMLInputElement>;

          props.onChange(syntheticEvent);
        }
      }

      if (props.onBlur) {
        props.onBlur(e);
      }
    };

    const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
      if (disableAutofill && !autofillUnlocked) {
        setAutofillUnlocked(true);
      }
      props.onFocus?.(e);
    };

    // For numeric inputs, use text type and manage value internally
    const inputType = isNumeric ? "text" : type;
    const inputValue = isNumeric ? tempValue : props.value;

    return (
      <input
        {...props}
        type={inputType}
        value={inputValue}
        onChange={handleChange}
        onBlur={handleBlur}
        {...(disableAutofill
          ? {
              name: randomName,
              autoComplete: "off",
              readOnly: !autofillUnlocked,
              onFocus: handleFocus,
              "data-lpignore": "true",
              "data-1p-ignore": "true",
              "data-form-type": "other",
            }
          : {})}
        className={cn(
          "flex h-11 w-full rounded-xl border border-input bg-input/50 px-4 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-all hover:bg-input/80 hover:border-primary/50 md:text-sm",
          className
        )}
        ref={ref}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
