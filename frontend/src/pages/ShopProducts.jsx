import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch } from "../lib/auth";
import "../styles/shop-products.css";

const API_URL = "http://localhost:5000/api";

function ShopProducts() {
  const { shopId } = useParams();
  const [shop, setShop] = useState(null);
  const [products, setProducts] = useState([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      apiFetch(`${API_URL}/shops/${shopId}`),
      apiFetch(`${API_URL}/shops/${shopId}/products`),
    ])
      .then(async ([shopResponse, productsResponse]) => {
        const shopData = await shopResponse.json();
        const productData = await productsResponse.json();
        if (!shopResponse.ok) throw new Error(shopData.error || "Shop not found");
        if (!productsResponse.ok) throw new Error(productData.error || "Could not load products");
        setShop(shopData);
        setProducts(productData);
      })
      .catch((e) => setError(e.message));
  }, [shopId]);

  const shown = products.filter((p) =>
    `${p.productName} ${p.brandName || ""} ${p.category?.name || ""}`.toLowerCase().includes(query.toLowerCase()),
  );

  if (error) return <div className="shop-products-page"><p>{error}</p></div>;
  if (!shop) return <div className="shop-products-page"><p>Loading shop products...</p></div>;

  return <div className="shop-products-page">
    <Link to={`/shops/${shop.id}`} className="back-link">← Back to Shop</Link>
    <div className="page-header">
      <p className="eyebrow">SHOP PRODUCTS</p>
      <h1 data-no-auto-translate="true" className="shop-identity">{shop.name}</h1>
      <p>{products.length} registered product record(s).</p>
    </div>
    <input className="shop-product-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search product or brand..." />
    <div className="shop-products-list">
      {shown.map((product) => (
        <Link key={product.id} to={`/products/item/${product.id}`} className="shop-product-item">
          <div>
            <h2 data-no-auto-translate="true" className="product-identity">{product.productName}</h2>
            <p>{product.brandName || "Brand not recorded"} · {product.netQuantity || "-"} {product.unit || ""} · {product.category?.name || "No category"}</p>
          </div>
          <span className={`product-status ${product.inspection?.status === "VIOLATION" ? "non-compliant" : product.inspection?.status === "NEEDS_REVIEW" ? "review" : "compliant"}`}>
            {product.inspection?.status || "NEEDS_REVIEW"}
          </span>
        </Link>
      ))}
      {!shown.length && <div className="status-message">No products match this search.</div>}
    </div>
  </div>;
}

export default ShopProducts;
