'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useAuth } from '../lib/auth';
import { formatMediaURL } from '../lib/data/strapi';
import { isExternalUrl, normalizeLinkUrl } from '../lib/security';

const NAVBAR = {
  brand: 'Vietpolyglots',
  logo: {
    url: '/uploads/vietpolyglots_logo_dff44d8aa8.png',
    alternativeText: 'Vietpolyglots',
    formats: {},
  },
  fixedMenu: [
    {
      id: 'services',
      label: 'Services',
      subItems: [
        { id: 'services-haro', label: 'HARO', url: '/haro' },
        { id: 'services-image-generate', label: 'Image Generate', url: '/image-generate' },
      ],
    },
    { id: 'account', label: 'Account', subItems: [] },
  ],
  dynamicMenu: [
    {
      id: 'home-group',
      label: 'Home',
      url: '/',
      subItems: [
        { id: 'projects', label: 'Projects', url: '/projects' },
        { id: 'meeting', label: 'Book Meeting', url: '/video-meeting' },
        { id: 'blog', label: 'Blog', url: '/blog' },
        { id: 'contact', label: 'Contact', url: '/#contact' },
      ],
    },
    {
      id: 'haro-group',
      label: 'HARO',
      url: '/haro',
      subItems: [
        { id: 'profile', label: 'Profile', url: '/haro/profile' },
        { id: 'pitches', label: 'Pitches', url: '/haro/pitches' },
        { id: 'journalists', label: 'Journalists', url: '/haro/journalists' },
      ],
    },
  ],
};

function normalizeUrl(url) {
  return normalizeLinkUrl(url);
}

function normalizeItem(item) {
  return {
    ...item,
    url: normalizeUrl(item?.url),
    subItems: Array.isArray(item?.subItems) ? item.subItems.map(normalizeItem) : [],
  };
}

function findMenuGroup(menu, matcher) {
  return menu.find((item) => matcher((item.label ?? '').toLowerCase(), item.url ?? '')) ?? null;
}

export default function Navbar({ data = NAVBAR }) {
  const [open, setOpen] = useState(false);
  const [openDropdown, setOpenDropdown] = useState(null);
  const navRef = useRef(null);
  const btnRef = useRef(null);
  const pathname = usePathname() || '/';
  const isHaroRoute = pathname.startsWith('/haro');
  const { user, logout } = useAuth();

  const normalizedData = useMemo(() => {
    const fixedMenu =
      Array.isArray(data.fixedMenu) && data.fixedMenu.length
        ? data.fixedMenu.map(normalizeItem)
        : NAVBAR.fixedMenu.map(normalizeItem);
    const dynamicMenu =
      Array.isArray(data.dynamicMenu) && data.dynamicMenu.length
        ? data.dynamicMenu.map(normalizeItem)
        : NAVBAR.dynamicMenu.map(normalizeItem);

    return {
      brand: data.brand ?? NAVBAR.brand,
      logo: data.logo ?? NAVBAR.logo,
      fixedMenu,
      dynamicMenu,
    };
  }, [data]);

  const logoUrl =
    formatMediaURL(
      normalizedData.logo?.formats?.thumbnail?.url ?? normalizedData.logo?.url ?? NAVBAR.logo.url
    ) || NAVBAR.logo.url;
  const brandLabel = normalizedData.brand ?? NAVBAR.brand;

  const homeGroup =
    findMenuGroup(normalizedData.dynamicMenu, (label, url) => label === 'home' || url === '/') ??
    normalizeItem(NAVBAR.dynamicMenu[0]);
  const haroGroup =
    findMenuGroup(
      normalizedData.dynamicMenu,
      (label, url) => label.includes('haro') || (url && url.startsWith('/haro'))
    ) ?? normalizeItem(NAVBAR.dynamicMenu[1]);

  const leftLinks = isHaroRoute
    ? [
        { id: homeGroup.id ?? 'home', label: homeGroup.label ?? 'Home', url: homeGroup.url ?? '/' },
        ...haroGroup.subItems,
      ]
    : [
        { id: homeGroup.id ?? 'home', label: homeGroup.label ?? 'Home', url: homeGroup.url ?? '/' },
        ...homeGroup.subItems,
      ];

  const serviceMenu =
    findMenuGroup(normalizedData.fixedMenu, (label) => label.includes('service')) ??
    normalizeItem(NAVBAR.fixedMenu[0]);
  const accountMenu =
    findMenuGroup(normalizedData.fixedMenu, (label) => label.includes('account')) ??
    normalizeItem(NAVBAR.fixedMenu[1]);

  const accountItems = user
    ? [
        ...accountMenu.subItems.filter((item) => item.url),
        { id: 'account-logout', label: 'Logout', action: 'logout' },
      ]
    : [{ id: 'account-login', label: 'Login', url: '/login' }];

  const handleLogout = () => {
    logout();
    setOpen(false);
    setOpenDropdown(null);
  };

  const closeMenus = () => {
    setOpen(false);
    setOpenDropdown(null);
  };

  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') {
        closeMenus();
      }
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  useEffect(() => {
    function onClick(event) {
      if (!navRef.current?.contains(event.target) && !btnRef.current?.contains(event.target)) {
        closeMenus();
      }
    }

    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      closeMenus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  const renderLink = (item, prefix = '') => {
    const key = `${prefix}-${item.id ?? 'no-id'}-${item.label ?? 'no-label'}-${item.url ?? 'no-url'}`;

    if (item.action === 'logout') {
      return (
        <button key={key} type="button" className="nav__action" onClick={handleLogout}>
          {item.label}
        </button>
      );
    }

    if (!item.url) {
      return (
        <span key={key} className="nav__link nav__link--muted">
          {item.label}
        </span>
      );
    }

    if (isExternalUrl(item.url)) {
      return (
        <a
          key={key}
          href={item.url}
          className="nav__link"
          target="_blank"
          rel="nofollow noopener noreferrer"
          onClick={closeMenus}
        >
          {item.label}
        </a>
      );
    }

    return (
      <Link
        key={key}
        href={item.url}
        className={pathname === item.url ? 'nav__link nav__link--active' : 'nav__link'}
        onClick={closeMenus}
      >
        {item.label}
      </Link>
    );
  };

  const renderDesktopDropdown = (item, items) => {
    const dropdownId = item.id ?? item.label;
    const isOpen = openDropdown === dropdownId;

    return (
      <div key={dropdownId} className="nav__dropdown">
        <button
          type="button"
          className={`nav__dropdown-trigger ${isOpen ? 'is-open' : ''}`}
          aria-expanded={isOpen}
          onClick={() => setOpenDropdown((current) => (current === dropdownId ? null : dropdownId))}
        >
          {item.label}
        </button>
        <div className={`nav__dropdown-menu ${isOpen ? 'is-open' : ''}`}>
          {items.map((subItem) => renderLink(subItem, `desktop-${dropdownId}-`))}
        </div>
      </div>
    );
  };

  const renderMobileSection = (title, items) => (
    <section className="nav__mobile-section" key={title}>
      <p className="nav__mobile-heading">{title}</p>
      <div className="nav__mobile-list">
        {items.map((item) => (
          <div key={`mobile-${title}-${item.id}-${item.label}`}>
            {renderLink(item, `mobile-${title}`)}
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <header className="nav" ref={navRef}>
      <nav className="nav__inner" aria-label="Primary">
        <Link href="/" className="nav__brand" onClick={closeMenus}>
          <Image
            src={logoUrl}
            alt={normalizedData.logo?.alternativeText ?? brandLabel}
            width={30}
            height={30}
            className="nav__brand-logo"
            priority
          />
          <span className="nav__brand-text">{brandLabel}</span>
        </Link>

        <div className="nav__links" aria-hidden={open ? 'true' : 'false'}>
          <div className="nav__group nav__group--left">
            {leftLinks.map((item) => renderLink(item, 'desktop-left'))}
          </div>

          <div className="nav__group nav__group--right">
            {renderDesktopDropdown(serviceMenu, serviceMenu.subItems)}
            {renderDesktopDropdown(accountMenu, accountItems)}
          </div>
        </div>

        <button
          ref={btnRef}
          className="nav__toggle"
          aria-controls="mobile-menu"
          aria-expanded={open}
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="nav__bar" />
          <span className="nav__bar" />
          <span className="nav__bar" />
        </button>
      </nav>

      <div id="mobile-menu" className={`nav__drawer ${open ? 'is-open' : ''}`}>
        {user?.name ? <p className="nav__mobile-user">Hi, {user.name}</p> : null}
        {renderMobileSection('Navigation', leftLinks)}
        {renderMobileSection(serviceMenu.label ?? 'Services', serviceMenu.subItems)}
        {renderMobileSection(accountMenu.label ?? 'Account', accountItems)}
      </div>
    </header>
  );
}
