import { Outlet } from 'react-router-dom';
import Layout from '../../components/Layout.jsx';

export default function AdminLayout() {
  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}
