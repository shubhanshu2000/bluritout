import { Button } from "./Button";

const navLinks = [
  { label: "Features", href: "#features" },
  { label: "Demo", href: "#demo" },
  { label: "Download", href: "#download" },
];

export function Navbar() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.08] bg-slate-950/70 backdrop-blur-xl">
      <div className="mx-auto flex h-20 max-w-7xl items-center justify-between px-6 sm:px-8 lg:px-12">
        <a href="#" className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl border border-indigo-300/20 bg-[linear-gradient(135deg,_rgba(99,102,241,0.25),_rgba(59,130,246,0.2))] text-sm font-semibold text-white shadow-[0_10px_30px_rgba(59,130,246,0.18)]">
            B
          </span>
          <span className="text-lg font-semibold tracking-tight text-white">
            BluritOut
          </span>
        </a>

        <nav className="hidden items-center gap-8 md:flex">
          {navLinks.map((item) => (
            <a
              key={item.label}
              href={item.href}
              className="text-sm text-slate-300 transition hover:text-white"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <div className="hidden sm:block">
            <Button href="#download" size="md">
              Download
            </Button>
          </div>
          <a
            href="#download"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-sm text-white transition hover:border-white/20 hover:bg-white/10 sm:hidden"
            aria-label="Download BluritOut"
          >
            ↓
          </a>
        </div>
      </div>
    </header>
  );
}
