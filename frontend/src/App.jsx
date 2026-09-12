import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import Layout from "./components/Layout";
import Rule23Assessment from "./components/Rule23Assessment";
import InspectionSubmissionGate from "./components/InspectionSubmissionGate";
import Dashboard from "./pages/Dashboard";
import Scan from "./pages/ScanV2";
import Shops from "./pages/Shops";
import ShopDetails from "./pages/ShopDetails";
import ShopProducts from "./pages/ShopProducts";
import Products from "./pages/Products";
import EcommerceProducts from "./pages/EcommerceProducts";
import EcommerceCategoryPage from "./pages/EcommerceCategoryPage";
import ProductDetails from "./pages/ProductDetails";
import CategoryPage from "./pages/CategoryPage";
import FoodProductRegistration from "./pages/FoodProductRegistration";
import ManualProductRegistration from "./pages/ManualProductRegistration";
import History from "./pages/History";
import Reports from "./pages/Reports";
import Profile from "./pages/Profile";
import Login from "./pages/Login";
import Register from "./pages/Register";
import VerifyEmail from "./pages/VerifyEmail";
import ResetPassword from "./pages/ResetPassword";
import AdminCategories from "./pages/AdminCategories";
import AdminGlobalCategoryType from "./pages/AdminGlobalCategoryType";
import AdminDashboard from "./pages/AdminDashboard";
import AdminRules from "./pages/AdminRules";
import EcommerceInspection from "./pages/EcommerceInspection";
import ComplianceIntelligence from "./pages/ComplianceIntelligence";
import BatchAlerts from "./pages/BatchAlerts";
import { getToken, getUser } from "./lib/auth";

function Protected() { const location = useLocation(); return getToken() ? <Outlet /> : <Navigate to="/login" replace state={{ from: location.pathname }} />; }
function AdminOnly() { return getUser()?.role === "ADMIN" ? <Outlet /> : <Navigate to="/" replace />; }

function ScanWithOfficerReview() {
  return <>
    <Scan />
    <Rule23Assessment />
    <InspectionSubmissionGate />
  </>;
}

function App() {
  return <BrowserRouter><Routes>
    <Route path="/login" element={<Login />} /><Route path="/register" element={<Register />} /><Route path="/verify-email" element={<VerifyEmail />} /><Route path="/forgot-password" element={<ResetPassword />} /><Route path="/reset-password" element={<ResetPassword />} />
    <Route element={<Protected />}><Route element={<Layout />}>
      <Route path="/" element={<Dashboard />} /><Route path="/scan" element={<ScanWithOfficerReview />} />
      <Route path="/ecommerce-inspection" element={<EcommerceInspection />} />
      <Route path="/shops" element={<Shops />} /><Route path="/shops/:shopId" element={<ShopDetails />} /><Route path="/shops/:shopId/products" element={<ShopProducts />} />
      <Route path="/products" element={<Products />} /><Route path="/products/category/:categoryId" element={<CategoryPage />} /><Route path="/products/item/:id" element={<ProductDetails />} />
      <Route path="/ecommerce-products" element={<EcommerceProducts />} /><Route path="/ecommerce-products/category/:categoryId" element={<EcommerceCategoryPage />} />
      <Route path="/products/register" element={<FoodProductRegistration />} /><Route path="/products/manual-register" element={<ManualProductRegistration />} />
      <Route path="/history" element={<History />} /><Route path="/reports" element={<Reports />} /><Route path="/profile" element={<Profile />} />
      <Route path="/intelligence" element={<ComplianceIntelligence />} />
      <Route path="/batch-alerts" element={<BatchAlerts />} />
      <Route element={<AdminOnly />}>
        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="/admin/categories" element={<AdminCategories />} />
        <Route path="/admin/categories/:sourceType" element={<AdminGlobalCategoryType />} />
        <Route path="/admin/categories/:sourceType/:categoryId" element={<CategoryPage />} />
        <Route path="/admin/rules" element={<AdminRules />} />
      </Route>
    </Route></Route>
  </Routes></BrowserRouter>;
}
export default App;
