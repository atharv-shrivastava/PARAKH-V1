import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch } from "../lib/auth";
import "../styles/shop-details.css";

const API_URL = "http://localhost:5000/api";
function statusClass(status) { if (["VIOLATION", "NON_COMPLIANT", "NON-COMPLIANT"].includes(status)) return "non-compliant"; if (["NEEDS_REVIEW", "UNABLE_TO_VERIFY", "REVIEW"].includes(status)) return "review"; return "compliant"; }

function ShopDetails() {
  const { shopId } = useParams(); const [shop, setShop] = useState(null); const [error, setError] = useState("");
  useEffect(() => { apiFetch(`${API_URL}/shops/${shopId}`).then(async (r) => { const data = await r.json(); if (!r.ok) throw new Error(data.error || "Shop not found"); setShop(data); }).catch((e) => setError(e.message)); }, [shopId]);
  if (error) return <div className="shop-details-page"><p>{error}</p></div>; if (!shop) return <div className="shop-details-page"><p>Loading shop...</p></div>;
  const ecommerce = String(shop.sourceType || "OFFLINE").toUpperCase() === "ECOMMERCE"; const statuses = shop.inspections?.map((i) => i.status) || []; const status = statuses.includes("VIOLATION") ? "Non-Compliant" : statuses.some((x) => ["NEEDS_REVIEW", "UNABLE_TO_VERIFY"].includes(x)) ? "Needs Review" : "Compliant";
  return <div className="shop-details-page">
    <Link to="/shops" className="back-link">← Back to Shops</Link>
    <div className="shop-details-header"><div><p className="eyebrow">{ecommerce ? "E-COMMERCE WEBSITE" : "OFFLINE SHOP"}</p><h1 data-no-auto-translate="true" className="shop-identity">{shop.name}</h1><p>{ecommerce ? "Website source for e-commerce inspections" : ([shop.address, shop.city, shop.state].filter(Boolean).join(", ") || "Address not recorded")}</p></div><span className={`shop-detail-status ${statusClass(status.toUpperCase().replace(" ", "_"))}`}>{status}</span></div>
    <section className="shop-overview"><div className="overview-card"><span>{ecommerce ? "Products from Website" : "Total Products"}</span><strong>{shop.productCount}</strong></div><div className="overview-card"><span>Inspections</span><strong>{shop.inspectionCount}</strong></div><div className="overview-card"><span>Last Inspection</span><strong>{shop.lastInspection ? new Date(shop.lastInspection).toLocaleString() : "None"}</strong></div></section>
    <section className="shop-products"><div className="section-heading"><div><h2>Registered Products</h2><p>{ecommerce ? "Products collected from this website source." : "Products registered through this shop's inspections."}</p></div><Link to={`/shops/${shop.id}/products`}>View all products</Link></div><div className="product-list">{(shop.inspections || []).map((inspection) => { const product = inspection.product; return <Link key={inspection.id} to={`/products/item/${product.id}`} className="product-row"><div><strong data-no-auto-translate="true" className="product-identity">{product.productName}</strong><span>{product.brandName || "Brand not recorded"} · {product.netQuantity || "-"} {product.unit || ""}</span></div><span className={`product-status ${statusClass(inspection.status)}`}>{inspection.status}</span></Link>; })}{!shop.inspections?.length && <div className="status-message">No inspections recorded for this {ecommerce ? "website" : "shop"}.</div>}</div></section>
  </div>;
}

export default ShopDetails;
