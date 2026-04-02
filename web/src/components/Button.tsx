import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  PropsWithChildren,
} from "react";

type CommonProps = PropsWithChildren<{
  className?: string;
  size?: "md" | "lg";
  variant?: "primary" | "secondary" | "ghost";
}>;

type LinkProps = CommonProps &
  AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
  };

type NativeButtonProps = CommonProps &
  ButtonHTMLAttributes<HTMLButtonElement> & {
    href?: undefined;
  };

type ButtonProps = LinkProps | NativeButtonProps;

const baseClasses =
  "inline-flex items-center justify-center gap-2 rounded-full border text-sm font-medium tracking-tight transition duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950";

const sizeClasses = {
  md: "px-5 py-3",
  lg: "px-6 py-3.5 text-[15px]",
};

const variantClasses = {
  primary:
    "border-indigo-300/20 bg-[linear-gradient(135deg,_#6366f1,_#3b82f6)] text-white shadow-[0_14px_40px_rgba(59,130,246,0.28)] hover:-translate-y-0.5 hover:shadow-[0_18px_48px_rgba(59,130,246,0.34)]",
  secondary:
    "border-white/[0.12] bg-white/[0.06] text-white hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/10",
  ghost:
    "border-transparent bg-transparent text-slate-300 hover:text-white",
};

function classesFor({
  className,
  size = "md",
  variant = "primary",
}: CommonProps) {
  return [baseClasses, sizeClasses[size], variantClasses[variant], className]
    .filter(Boolean)
    .join(" ");
}

export function Button(props: ButtonProps) {
  if ("href" in props && props.href) {
    const { children, className, size, variant, ...rest } = props;

    return (
      <a className={classesFor({ className, size, variant })} {...rest}>
        {children}
      </a>
    );
  }

  const { children, className, size, variant, type = "button", ...rest } = props;

  return (
    <button
      className={classesFor({ className, size, variant })}
      type={type as "button" | "submit" | "reset" | undefined}
      {...rest}
    >
      {children}
    </button>
  );
}
