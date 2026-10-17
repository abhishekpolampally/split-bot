export default function Offline() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 bg-head p-8 text-center text-white">
      <h1 className="text-2xl font-extrabold">You&apos;re offline</h1>
      <p className="text-mint">SplitBot needs a connection to keep everyone&apos;s balances in sync. It&apos;ll pick up where you left off.</p>
    </main>
  );
}
