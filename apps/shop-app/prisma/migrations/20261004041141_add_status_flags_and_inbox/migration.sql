/*
  Warnings:

  - Added the required column `updatedAt` to the `InvoiceAttempt` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Payment` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "ReviewFlag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paymentId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "relatedAttemptId" TEXT,
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "ReviewFlag_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ReviewFlag_attemptId_paymentId_fkey" FOREIGN KEY ("attemptId", "paymentId") REFERENCES "InvoiceAttempt" ("id", "paymentId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ReviewFlag_relatedAttemptId_paymentId_fkey" FOREIGN KEY ("relatedAttemptId", "paymentId") REFERENCES "InvoiceAttempt" ("id", "paymentId") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "Inbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InvoiceAttempt_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
INSERT INTO "new_InvoiceAttempt" ("id", "paymentId") SELECT "id", "paymentId" FROM "InvoiceAttempt";
DROP TABLE "InvoiceAttempt";
ALTER TABLE "new_InvoiceAttempt" RENAME TO "InvoiceAttempt";
CREATE UNIQUE INDEX "InvoiceAttempt_btcpayInvoiceId_key" ON "InvoiceAttempt"("btcpayInvoiceId");
CREATE INDEX "InvoiceAttempt_status_idx" ON "InvoiceAttempt"("status");
CREATE UNIQUE INDEX "InvoiceAttempt_id_paymentId_key" ON "InvoiceAttempt"("id", "paymentId");
CREATE TABLE "new_Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyOrderId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATING',
    "version" INTEGER NOT NULL DEFAULT 0,
    "currentAttemptId" TEXT,
    "shopifySync" TEXT NOT NULL DEFAULT 'DONE',
    "shopifySyncError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Payment_currentAttemptId_id_fkey" FOREIGN KEY ("currentAttemptId", "id") REFERENCES "InvoiceAttempt" ("id", "paymentId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
INSERT INTO "new_Payment" ("currentAttemptId", "id", "shopifyOrderId") SELECT "currentAttemptId", "id", "shopifyOrderId" FROM "Payment";
DROP TABLE "Payment";
ALTER TABLE "new_Payment" RENAME TO "Payment";
CREATE UNIQUE INDEX "Payment_shopifyOrderId_key" ON "Payment"("shopifyOrderId");
CREATE UNIQUE INDEX "Payment_currentAttemptId_key" ON "Payment"("currentAttemptId");
CREATE INDEX "Payment_shopifySync_idx" ON "Payment"("shopifySync");
CREATE UNIQUE INDEX "Payment_currentAttemptId_id_key" ON "Payment"("currentAttemptId", "id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "ReviewFlag_paymentId_reason_attemptId_key" ON "ReviewFlag"("paymentId", "reason", "attemptId");

-- CreateIndex
CREATE INDEX "Inbox_status_idx" ON "Inbox"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Inbox_source_eventId_key" ON "Inbox"("source", "eventId");
