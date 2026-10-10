-- 既存の行は、この列を足す前に開発ストア（1店舗）で作ったもの。そのショップをオフラインセッションから埋める。
-- オフラインセッションのショップがちょうど1つでなければ（ない・複数ある）、NOT NULL の違反で止まる（推測では埋めない）
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
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
INSERT INTO "new_Payment" ("createdAt", "currentAttemptId", "id", "shop", "shopifyOrderId", "shopifySync", "shopifySyncError", "status", "updatedAt", "version") SELECT "createdAt", "currentAttemptId", "id", (SELECT MIN("shop") FROM "Session" WHERE "isOnline" = false HAVING COUNT(DISTINCT "shop") = 1), "shopifyOrderId", "shopifySync", "shopifySyncError", "status", "updatedAt", "version" FROM "Payment";
DROP TABLE "Payment";
ALTER TABLE "new_Payment" RENAME TO "Payment";
CREATE UNIQUE INDEX "Payment_shopifyOrderId_key" ON "Payment"("shopifyOrderId");
CREATE UNIQUE INDEX "Payment_currentAttemptId_key" ON "Payment"("currentAttemptId");
CREATE INDEX "Payment_shopifySync_idx" ON "Payment"("shopifySync");
CREATE UNIQUE INDEX "Payment_currentAttemptId_id_key" ON "Payment"("currentAttemptId", "id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
