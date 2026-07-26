import Link from "next/link";
import { DEVICES } from "@/lib/devices";

export default function Home() {
  return (
    <main className="container">
      <header className="pageHeader">
        <h1>Environmental Logger</h1>
        <p className="subtitle">Select a device to view its readings and photos.</p>
      </header>

      <section className="deviceList">
        {DEVICES.map((d) => (
          <Link key={d.id} href={`/devices/${d.id}`} className="deviceCard">
            <span className="deviceName">{d.name}</span>
            <span className="deviceLocation">{d.location}</span>
            <span className="deviceId">{d.id}</span>
          </Link>
        ))}
      </section>
    </main>
  );
}
