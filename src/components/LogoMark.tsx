type Props = {
  className?: string;
  /** mark = 仅图标（继承 currentColor）；app = 橙底圆角方块 + 白标 */
  variant?: "mark" | "app";
  title?: string;
};

/** Ascending Pennant：三阶上升柱 + 右端三角旗尖 */
export default function LogoMark({
  className = "w-8 h-8",
  variant = "mark",
  title = "StepUp",
}: Props) {
  const mark = (
    <svg
      viewBox="0 0 32 32"
      className={variant === "mark" ? className : "w-[58%] h-[58%]"}
      fill="currentColor"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {/* 左矮柱 */}
      <rect x="5" y="18" width="5.5" height="10" rx="1.2" />
      {/* 中柱 */}
      <rect x="13.25" y="12" width="5.5" height="16" rx="1.2" />
      {/* 右高柱 + 上升旗尖 */}
      <path d="M21.5 28V11.2L25.5 6.5l4 4.7V28H21.5z" />
    </svg>
  );

  if (variant === "app") {
    return (
      <span
        className={`inline-flex items-center justify-center rounded-xl bg-brand-500 text-white ${className}`}
        aria-label={title}
      >
        {mark}
      </span>
    );
  }

  return mark;
}
