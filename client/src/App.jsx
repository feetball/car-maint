import { Link, NavLink, Route, Routes } from 'react-router-dom';
import Icon from './components/Icon.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Vehicles from './pages/Vehicles.jsx';
import VehicleDetail from './pages/VehicleDetail.jsx';
import Backup from './pages/Backup.jsx';

const navClass = ({ isActive }) => `nav-link${isActive ? ' nav-link--active' : ''}`;

function NotFound() {
  return (
    <div className="page">
      <div className="empty-state">
        <div className="empty-state__icon">
          <Icon name="crosshair" size={26} />
        </div>
        <h3 className="empty-state__title">Page not found</h3>
        <p className="empty-state__message">That route doesn&apos;t exist.</p>
        <Link className="button button--primary" to="/">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link to="/" className="brand">
          <span className="brand__mark">
            <Icon name="wrench" size={17} />
          </span>
          <span className="brand__name">CarMaint</span>
        </Link>
        <nav className="sidebar__nav" aria-label="Primary">
          <NavLink to="/" end className={navClass}>
            <Icon name="grid" size={17} />
            <span>Dashboard</span>
          </NavLink>
          <NavLink to="/vehicles" className={navClass}>
            <Icon name="car" size={17} />
            <span>Vehicles</span>
          </NavLink>
          <NavLink to="/backup" className={navClass}>
            <Icon name="cloud" size={17} />
            <span>Backup</span>
          </NavLink>
        </nav>
        <p className="sidebar__footer">Every mile, accounted for.</p>
      </aside>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/vehicles" element={<Vehicles />} />
          <Route path="/vehicles/:id" element={<VehicleDetail />} />
          <Route path="/backup" element={<Backup />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}
