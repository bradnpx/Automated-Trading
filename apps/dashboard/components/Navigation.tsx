import React from 'react';

export default function Nav() {
    const navItems = {
        home: '/',
        logs: '/logs',
        earnings: '/earnings',
    }
    return (
      <nav className="w-full bg-[#000044]">
        <ul className="nav-links py-4">
          {Object.entries(navItems).map(([k, v]) => (
            <li key={k} className='inline-block'>
              <a href={v} className='p-4'>{k}</a>
            </li>
          ))}
        </ul>
      </nav>
    );
}