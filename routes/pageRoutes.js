'use strict';

const express = require('express');
const store = require('../data/store');
const { buildOrderPdf, buildProductionPdf } = require('../utils/bakeryPdf');

const router = express.Router();

function today() {
  return new Date().toISOString().slice(0, 10);
}

function mapOrderStatusLabel(status) {
  if (status === store.ORDER_STATUS.SUBMITTED) return 'Abgegeben';
  return 'Entwurf';
}

function getUserIdentity(req) {
  return (
    req.session?.user?.email ||
    req.session?.user?.name ||
    req.session?.admin?.email ||
    req.session?.admin?.name ||
    'System'
  );
}

function buildBaseViewModel(req, extra = {}) {
  return {
    title: 'Bakery',
    currentPath: req.path,
    bakeryNav: [
      { href: '/bakery/order', label: 'Bestellung' },
      { href: '/bakery/items', label: 'Artikel' },
      { href: '/bakery/orders', label: 'Bestellungen' },
      { href: '/bakery/reports', label: 'Berichte' },
    ],
    success: req.query.success || '',
    error: req.query.error || '',
    userName: getUserIdentity(req),
    ...extra,
  };
}

async function loadShopOptions(selectedShopId) {
  const shops = await store.listShops({ activeOnly: true });
  return shops.map((shop) => ({
    ...shop,
    selected: String(shop.id) === String(selectedShopId || ''),
  }));
}

function buildItemsGrouped(items = []) {
  const grouped = [];
  const map = new Map();

  for (const item of items) {
    const key = item.category && String(item.category).trim()
      ? String(item.category).trim()
      : 'Ohne Kategorie';

    if (!map.has(key)) {
      const group = { category: key, items: [] };
      map.set(key, group);
      grouped.push(group);
    }

    map.get(key).items.push(item);
  }

  return grouped;
}

router.get('/bakery', async (req, res) => {
  return res.redirect('/bakery/order');
});

router.get('/bakery/order', async (req, res, next) => {
  try {
    const shopOptions = await loadShopOptions(req.query.shopId);
    const selectedShopId =
      req.query.shopId ||
      (shopOptions[0] ? String(shopOptions[0].id) : '');

    const orderDate = req.query.date || today();

    let orderData = null;
    let groupedItems = [];
    let selectedShop = null;

    if (selectedShopId) {
      selectedShop = await store.getShopById(Number(selectedShopId));

      if (selectedShop) {
        orderData = await store.getOrderEditorData({
          shopId: selectedShop.id,
          orderDate,
          createdBy: getUserIdentity(req),
        });

        groupedItems = buildItemsGrouped(orderData.items);
      }
    }

    return res.render(
      'order',
      buildBaseViewModel(req, {
        title: 'Bakery | Bestellung',
        pageTitle: 'Bestellung',
        pageSubtitle: 'IST Bestand eintragen, Vorschlag prüfen und Bestellung speichern oder abgeben.',
        shopOptions,
        selectedShopId: selectedShop ? String(selectedShop.id) : '',
        selectedShop,
        orderDate,
        groupedItems,
        order: orderData?.order || null,
        orderStatusLabel: mapOrderStatusLabel(orderData?.order?.status),
        isSubmitted: orderData?.order?.status === store.ORDER_STATUS.SUBMITTED,
        note: orderData?.order?.note || '',
        totals: {
          totalItems: orderData?.items?.length || 0,
          totalSuggestedQty: (orderData?.items || []).reduce((sum, item) => sum + Number(item.suggestedQty || 0), 0),
          totalOrderedQty: (orderData?.items || []).reduce((sum, item) => sum + Number(item.orderedQty || 0), 0),
        },
      })
    );
  } catch (error) {
    next(error);
  }
});

router.get('/bakery/items', async (req, res, next) => {
  try {
    const items = await store.listItems({ includeShopSettings: true });
    const shops = await store.listShops();

    const preparedItems = items.map((item) => {
      const settingMap = new Map(
        (item.shopSettings || []).map((setting) => [String(setting.shopId), setting])
      );

      const shopSettings = shops.map((shop) => {
        const setting = settingMap.get(String(shop.id));
        return {
          shopId: shop.id,
          shopName: shop.name,
          shopCode: shop.code,
          sollBestand: setting ? Number(setting.sollBestand || 0) : 0,
          activeForShop: setting ? !!setting.activeForShop : false,
        };
      });

      return {
        ...item,
        shopSettings,
      };
    });

    return res.render(
      'items',
      buildBaseViewModel(req, {
        title: 'Bakery | Artikel',
        pageTitle: 'Artikel',
        pageSubtitle: 'Artikel, Kategorien und SOLL Bestand je Shop zentral verwalten.',
        items: preparedItems,
        shops,
        bulkTemplate:
          'Croissant; Viennoiserie; Stk; 1\nPain au Chocolat; Viennoiserie; Stk; 2\nCheesecake; Kuchen; Stk; 3',
      })
    );
  } catch (error) {
    next(error);
  }
});

router.get('/bakery/orders', async (req, res, next) => {
  try {
    const shopOptions = await loadShopOptions(req.query.shopId);
    const filters = {
      shopId: req.query.shopId ? Number(req.query.shopId) : null,
      status: req.query.status || null,
      dateFrom: req.query.dateFrom || null,
      dateTo: req.query.dateTo || null,
    };

    const orders = await store.listOrders(filters);

    const ordersWithLabels = orders.map((order) => ({
      ...order,
      statusLabel: mapOrderStatusLabel(order.status),
    }));

    return res.render(
      'orders',
      buildBaseViewModel(req, {
        title: 'Bakery | Bestellungen',
        pageTitle: 'Bestellungen',
        pageSubtitle: 'Alle Bestellungen nach Shop, Datum und Status prüfen.',
        orders: ordersWithLabels,
        shopOptions: [
          { id: '', name: 'Alle Shops', selected: !filters.shopId },
          ...shopOptions,
        ],
        filters: {
          shopId: filters.shopId ? String(filters.shopId) : '',
          status: filters.status || '',
          dateFrom: filters.dateFrom || '',
          dateTo: filters.dateTo || '',
        },
        statusOptions: [
          { value: '', label: 'Alle Status', selected: !filters.status },
          {
            value: store.ORDER_STATUS.DRAFT,
            label: 'Entwurf',
            selected: filters.status === store.ORDER_STATUS.DRAFT,
          },
          {
            value: store.ORDER_STATUS.SUBMITTED,
            label: 'Abgegeben',
            selected: filters.status === store.ORDER_STATUS.SUBMITTED,
          },
        ],
      })
    );
  } catch (error) {
    next(error);
  }
});

router.get('/bakery/orders/:id', async (req, res, next) => {
  try {
    const order = await store.getOrderWithLines(Number(req.params.id));

    if (!order) {
      return res.status(404).render(
        'orders',
        buildBaseViewModel(req, {
          title: 'Bakery | Bestellung nicht gefunden',
          pageTitle: 'Bestellungen',
          pageSubtitle: 'Die angefragte Bestellung wurde nicht gefunden.',
          orders: [],
          shopOptions: [{ id: '', name: 'Alle Shops', selected: true }],
          filters: {
            shopId: '',
            status: '',
            dateFrom: '',
            dateTo: '',
          },
          statusOptions: [
            { value: '', label: 'Alle Status', selected: true },
          ],
          error: 'Bestellung nicht gefunden.',
        })
      );
    }

    return res.render(
      'order',
      buildBaseViewModel(req, {
        title: `Bakery | Bestellung ${order.shopName || ''}`,
        pageTitle: 'Bestellung ansehen',
        pageSubtitle: 'Einzelne Bestellung mit allen Positionen.',
        shopOptions: (await loadShopOptions(order.shopId)).map((shop) => ({
          ...shop,
          selected: String(shop.id) === String(order.shopId),
        })),
        selectedShopId: String(order.shopId),
        selectedShop: {
          id: order.shopId,
          name: order.shopName,
          code: order.shopCode,
        },
        orderDate: order.orderDate,
        groupedItems: buildItemsGrouped(
          (order.lines || []).map((line) => ({
            itemId: line.itemId,
            name: line.itemName,
            category: line.category,
            unit: line.unit,
            sortOrder: line.sortOrder,
            sollBestand: line.sollBestand,
            istBestand: line.istBestand,
            suggestedQty: line.suggestedQty,
            orderedQty: line.orderedQty,
            manualOverride: line.manualOverride,
          }))
        ),
        order,
        orderStatusLabel: mapOrderStatusLabel(order.status),
        isSubmitted: order.status === store.ORDER_STATUS.SUBMITTED,
        isReadonlyView: true,
        note: order.note || '',
        totals: {
          totalItems: order.lines?.length || 0,
          totalSuggestedQty: (order.lines || []).reduce((sum, item) => sum + Number(item.suggestedQty || 0), 0),
          totalOrderedQty: (order.lines || []).reduce((sum, item) => sum + Number(item.orderedQty || 0), 0),
        },
      })
    );
  } catch (error) {
    next(error);
  }
});

router.get('/bakery/orders/:id/pdf', async (req, res, next) => {
  try {
    const order = await store.getOrderWithLines(Number(req.params.id));

    if (!order) {
      return res.status(404).send('Bestellung nicht gefunden.');
    }

    buildOrderPdf(res, order);
  } catch (error) {
    next(error);
  }
});

router.get('/bakery/reports', async (req, res, next) => {
  try {
    const reportDate = req.query.reportDate || today();
    const dateFrom = req.query.dateFrom || reportDate;
    const dateTo = req.query.dateTo || reportDate;
    const selectedShopId = req.query.shopId || '';

    const [productionReport, dateRangeReport, shopOptions] = await Promise.all([
      store.getProductionReport({ orderDate: reportDate, onlySubmitted: true }),
      store.getDateRangeReport({
        dateFrom,
        dateTo,
        shopId: selectedShopId ? Number(selectedShopId) : null,
        onlySubmitted: true,
      }),
      loadShopOptions(selectedShopId),
    ]);

    return res.render(
      'reports',
      buildBaseViewModel(req, {
        title: 'Bakery | Berichte',
        pageTitle: 'Berichte',
        pageSubtitle: 'Tagesproduktion und Zeitraum-Auswertung auf einen Blick.',
        reportDate,
        dateFrom,
        dateTo,
        selectedShopId,
        shopOptions: [
          { id: '', name: 'Alle Shops', selected: !selectedShopId },
          ...shopOptions,
        ],
        productionReport,
        dateRangeReport,
      })
    );
  } catch (error) {
    next(error);
  }
});

router.get('/bakery/reports/production/pdf', async (req, res, next) => {
  try {
    const reportDate = req.query.reportDate || today();
    const productionReport = await store.getProductionReport({
      orderDate: reportDate,
      onlySubmitted: true,
    });

    buildProductionPdf(res, productionReport, {
      orderDate: reportDate,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
