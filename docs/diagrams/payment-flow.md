# 図: 支払いの流れと状態

README から参照する図。内容の正は [design.md](../design.md) の 4章・5章。

## invoice の作成から支払い済みまで（正常系）

```mermaid
sequenceDiagram
    autonumber
    actor B as 購入者
    participant S as Shopify
    participant A as shop-app
    participant D as SQLite
    participant P as BTCPay Server
    participant C as bitcoind（regtest）

    B->>S: 「Bitcoinで支払う」で注文を確定
    S->>A: orders/create Webhook
    A->>S: Admin API で注文を取り直す（請求額・支払い方法・状態）
    A->>D: 1つのトランザクションで Payment・試行・ポインタを予約（CREATING）
    A->>P: invoice を作成（orderId 欄 = attemptId）
    A->>D: btcpayInvoiceId を保存（AWAITING_PAYMENT）
    B->>A: Thank you ページの拡張から問い合わせ（sessionToken）
    A-->>B: checkout link と表示状態
    B->>C: 支払い（regtest では bitcoin-cli）
    C-->>P: 入金を検知 → 1ブロックで Settled
    P->>A: Webhook（BTCPay-Sig を検証）
    A->>D: inbox に保存して 200
    Note over A: ワーカーが Greenfield から invoice を取り直し、<br/>ドメインで遷移を判定して version 付きで更新（PAID, shopifySync = PENDING）
    A->>S: orderMarkAsPaid（すでに PAID ならスキップ）
    A->>D: shopifySync = DONE（version 付き）
```

Webhook が届かなくても、プロセスが途中で落ちても、30秒ごとのスイープ（design.md 5.5）が孤児の回復・照合・inbox の再処理・Shopify への反映を行い、同じ状態に収束させる。

## Payment.status

```mermaid
stateDiagram-v2
    [*] --> CREATING
    CREATING --> AWAITING_PAYMENT: 試行が NEW
    AWAITING_PAYMENT --> CONFIRMING: 試行が PROCESSING
    CONFIRMING --> PAID: 試行が SETTLED
    AWAITING_PAYMENT --> EXPIRED: 入金なしで期限切れ
    EXPIRED --> CREATING: 再発行（新しい試行を作る）
    CONFIRMING --> UNRESOLVED: INVALID_PAYMENT
    EXPIRED --> UNRESOLVED: UNDERPAID / LATE_PAYMENT
    AWAITING_PAYMENT --> UNRESOLVED: 古い試行に期限後の入金（LATE_PAYMENT）
    PAID --> [*]
    UNRESOLVED --> [*]
```

- 終端は PAID と UNRESOLVED。UNRESOLVED には必ずフラグ（ReviewFlag）が1つ以上ある。
- フラグ（UNDERPAID・LATE_PAYMENT・DOUBLE_PAYMENT・INVALID_PAYMENT・OVERPAID）は status とは別の軸で持ち、
  Shopify の注文にタグ `btc-review-<reason>` として出す（ADR 6）。

## InvoiceAttempt.status

```mermaid
stateDiagram-v2
    direction LR
    [*] --> CREATING
    CREATING --> NEW
    NEW --> PROCESSING
    PROCESSING --> SETTLED
    NEW --> EXPIRED
    PROCESSING --> INVALID
    NEW --> INVALID: アプリが無効化
```

BTCPay の invoice の状態を写したもの。前にしか進まないので、古い状態を取り直しても害にならない（無効な遷移は何もしない）。
