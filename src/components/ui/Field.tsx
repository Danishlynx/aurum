import type { ChangeEvent } from "react";

/**
 * Field, per docs/02-design-system.md: Basalt fill, Umber hairline, Ivory text,
 * gold hairline on focus, 52 high, placeholder in Sand.
 *
 * There is no red anywhere in the system, so the error is Ivory text on Basalt
 * behind a gold hairline and the words carry the meaning.
 */

type FieldProps = {
  readonly id: string;
  readonly label: string;
  /** True when the placeholder already says what the field is, as on /judge. */
  readonly labelHidden?: boolean;
  readonly placeholder?: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly error?: string | null;
  readonly disabled?: boolean;
  readonly autoComplete?: string;
  readonly inputMode?: "text" | "numeric" | "email";
  readonly maxLength?: number;
};

export function Field({
  id,
  label,
  labelHidden = false,
  placeholder,
  value,
  onValueChange,
  error = null,
  disabled = false,
  autoComplete = "off",
  inputMode = "text",
  maxLength,
}: FieldProps) {
  const errorId = `${id}-error`;

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    onValueChange(event.target.value);
  }

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={id}
        className={
          labelHidden
            ? "sr-only"
            : "font-body text-small text-text-muted"
        }
      >
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        aria-invalid={error !== null}
        aria-describedby={error !== null ? errorId : undefined}
        className="h-[52px] w-full rounded-sm border border-raised bg-surface px-4 font-body text-body text-text placeholder:text-text-muted focus:border-accent"
      />
      {error !== null ? (
        <p
          id={errorId}
          role="status"
          className="rounded-sm border border-accent bg-surface px-4 py-3 font-body text-small text-text"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
