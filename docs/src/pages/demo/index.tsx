import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';

export default function DemoPage() {
  return (
    <Layout title="Demo" description="A Demo of UpscalerJS">
      <BrowserOnly>
        {() => {
          const Demo = require('@site/src/components/demo/demo').Demo; // skipcq: js-0359
          return (<Demo />);
        }}
      </BrowserOnly>
    </Layout>
  );
}