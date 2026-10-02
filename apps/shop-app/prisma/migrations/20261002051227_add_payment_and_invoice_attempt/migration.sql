-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyOrderId" TEXT NOT NULL,
    "currentAttemptId" TEXT,
    CONSTRAINT "Payment_currentAttemptId_id_fkey" FOREIGN KEY ("currentAttemptId", "id") REFERENCES "InvoiceAttempt" ("id", "paymentId") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateTable
CREATE TABLE "InvoiceAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paymentId" TEXT NOT NULL,
    CONSTRAINT "InvoiceAttempt_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_shopifyOrderId_key" ON "Payment"("shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_currentAttemptId_key" ON "Payment"("currentAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_currentAttemptId_id_key" ON "Payment"("currentAttemptId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceAttempt_id_paymentId_key" ON "InvoiceAttempt"("id", "paymentId");
