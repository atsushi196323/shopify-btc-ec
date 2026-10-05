-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_InvoiceAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paymentId" TEXT NOT NULL,
    "btcpayInvoiceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CREATING',
    "invalidatedByUs" BOOLEAN NOT NULL DEFAULT false,
    "invalidatedAt" DATETIME,
    "paymentDetected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InvoiceAttempt_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
INSERT INTO "new_InvoiceAttempt" ("btcpayInvoiceId", "createdAt", "id", "invalidatedAt", "invalidatedByUs", "paymentId", "status", "updatedAt") SELECT "btcpayInvoiceId", "createdAt", "id", "invalidatedAt", "invalidatedByUs", "paymentId", "status", "updatedAt" FROM "InvoiceAttempt";
DROP TABLE "InvoiceAttempt";
ALTER TABLE "new_InvoiceAttempt" RENAME TO "InvoiceAttempt";
CREATE UNIQUE INDEX "InvoiceAttempt_btcpayInvoiceId_key" ON "InvoiceAttempt"("btcpayInvoiceId");
CREATE INDEX "InvoiceAttempt_status_idx" ON "InvoiceAttempt"("status");
CREATE UNIQUE INDEX "InvoiceAttempt_id_paymentId_key" ON "InvoiceAttempt"("id", "paymentId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
