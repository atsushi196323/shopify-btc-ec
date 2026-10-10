// ショップのドメイン（xxx.myshopify.com）を、Payment.shop に保存し比べる形にそろえる（ADR 8）。
// orders/create の Webhook のショップと、拡張のセッショントークンの dest は出どころが違うので、表記の揺れ（大文字・https://・末尾の /）を吸収する
export function normalizeShopDomain(shop: string): string {
  return shop
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}
