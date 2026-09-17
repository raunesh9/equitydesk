import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'EquityDesk · Stock Research',
  description: 'Your local stock research, watchlist, and portfolio workspace.',
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
