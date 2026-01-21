import "dotenv/config";
import { startProducer } from "./producer.ts";
import { processPackage } from "./worker.ts";
import { packageQueue } from "./lib/in-memory-queue.ts";

if (process.env.GITHUB_ACTIONS === 'true') {
  console.log("Exécution dans une GitHub Action : activation du timeout de 5 minutes.");

  setTimeout(() => {
    console.log("Arrêt du script après 5 minutes (GitHub Action).");
    process.exit(0); // Arrête le processus avec succès
  }, 300000); // 300 000 ms = 5 minutes
} else {
  console.log("Exécution locale : pas de timeout activé.");
}

function nowIso(): string {
  return new Date().toISOString();
}

async function main() {
  console.log(`[${nowIso()}] Starting application...`);

  // Start the worker processing
  packageQueue.process(processPackage);
  console.log(`[${nowIso()}] Worker started.`);

  // Start the producer
  await startProducer();
}

main().catch((e) => {
  const errorMessage = e instanceof Error && e.stack ? e.stack : String(e);
  console.error(`[${nowIso()}] fatal: ${errorMessage}\n`);
  process.exitCode = 1;
});
