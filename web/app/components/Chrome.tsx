import type { ReactNode } from "react";
import Link from "next/link";

const NAV = [
  { href: "/", label: "Hub" },
  { href: "/trailblazers", label: "Trailblazers" },
  { href: "/tools/flow-linter", label: "Flow Studio" },
  { href: "/tools/security-audit", label: "Security" },
  { href: "/tools/field-impact", label: "Field Impact" },
];

export function Chrome({
  title,
  path,
  children,
}: {
  title: string;
  path: string;
  children: ReactNode;
}) {
  return (
    <div className="chrome">
      <header className="top">
        <div className="top-row">
          <Link href="/" className="brand">
            <span className="mark" aria-hidden />
            SFDT
          </Link>
          <span className="faint">/</span>
          <strong style={{ fontSize: 14, fontWeight: 500 }}>{title}</strong>
          <span className="org">No org</span>
        </div>
        <nav className="nav" aria-label="Primary">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={path === item.href || (item.href !== "/" && path.startsWith(item.href)) ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}
