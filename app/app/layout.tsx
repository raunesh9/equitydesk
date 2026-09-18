import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'EquityDesk · Stock Research',
  description:
    'Stock research, portfolio tracking, and practice investing with virtual money.',
  icons: { icon: '/favicon.svg' },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
