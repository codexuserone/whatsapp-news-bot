const { getClient } = require('./supabase');

const DOCUMENTS_TABLE = 'documents';

const serializeData = (data) => JSON.parse(JSON.stringify(data ?? {}));

const normalizeDate = (value) => (value instanceof Date ? value.toISOString() : value);

const mapRow = (row, dateFields) => {
  if (!row) return null;
  const data = { ...(row.data || {}) };
  dateFields.forEach((field) => {
    if (data[field]) {
      data[field] = new Date(data[field]);
    }
  });
  return {
    _id: row.id,
    ...data,
    createdAt: row.created_at ? new Date(row.created_at) : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at) : undefined
  };
};

const applyFilters = (query, filters, arrayFields) => {
  const entries = Object.entries(filters || {}).filter(([key]) => key !== '$or');
  let nextQuery = query;
  entries.forEach(([key, value]) => {
    if (key === '_id') {
      if (value && typeof value === 'object' && '$in' in value) {
        nextQuery = nextQuery.in('id', value.$in);
      } else {
        nextQuery = nextQuery.eq('id', value);
      }
      return;
    }

    if (key === 'createdAt' || key === 'updatedAt') {
      const column = key === 'createdAt' ? 'created_at' : 'updated_at';
      if (value && typeof value === 'object') {
        if ('$gte' in value) {
          nextQuery = nextQuery.gte(column, normalizeDate(value.$gte));
        }
        if ('$lt' in value) {
          nextQuery = nextQuery.lt(column, normalizeDate(value.$lt));
        }
      }
      return;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('$in' in value) {
        nextQuery = nextQuery.in(`data->>${key}`, value.$in);
        return;
      }
      if ('$gte' in value || '$lt' in value) {
        if ('$gte' in value) {
          nextQuery = nextQuery.gte(`data->>${key}`, normalizeDate(value.$gte));
        }
        if ('$lt' in value) {
          nextQuery = nextQuery.lt(`data->>${key}`, normalizeDate(value.$lt));
        }
        return;
      }
    }

    if (arrayFields.has(key)) {
      nextQuery = nextQuery.contains('data', { [key]: [value].flat() });
    } else {
      nextQuery = nextQuery.contains('data', { [key]: value });
    }
  });
  return nextQuery;
};

const createModel = (collection, options = {}) => {
  const dateFields = options.dateFields || [];
  const arrayFields = new Set(options.arrayFields || []);

  const baseSelect = () =>
    getClient().from(DOCUMENTS_TABLE).select('id,data,created_at,updated_at').eq('collection', collection);

  const find = async (filters = {}, queryOptions = {}) => {
    if (filters.$or) {
      const base = { ...filters };
      delete base.$or;
      const results = await Promise.all(
        filters.$or.map((condition) => find({ ...base, ...condition }, queryOptions))
      );
      const merged = new Map();
      results.flat().forEach((item) => {
        merged.set(item._id, item);
      });
      return Array.from(merged.values());
    }

    let query = applyFilters(baseSelect(), filters, arrayFields);

    if (queryOptions.orderBy) {
      query = query.order(queryOptions.orderBy.column, { ascending: queryOptions.orderBy.ascending });
    }
    if (queryOptions.limit) {
      query = query.limit(queryOptions.limit);
    }

    const { data, error } = await query;
    if (error) {
      throw error;
    }

    let rows = (data || []).map((row) => mapRow(row, dateFields));
    if (queryOptions.select && queryOptions.select.length) {
      rows = rows.map((row) => {
        const selected = {};
        queryOptions.select.forEach((field) => {
          selected[field] = row[field];
        });
        return selected;
      });
    }
    return rows;
  };

  const findOne = async (filters = {}) => {
    if (filters.$or) {
      const base = { ...filters };
      delete base.$or;
      for (const condition of filters.$or) {
        const match = await findOne({ ...base, ...condition });
        if (match) return match;
      }
      return null;
    }
    const results = await find(filters, { limit: 1 });
    return results[0] || null;
  };

  const findById = async (id) => findOne({ _id: id });

  const create = async (data) => {
    const now = new Date().toISOString();
    const payload = {
      collection,
      data: serializeData(data),
      created_at: now,
      updated_at: now
    };
    const { data: rows, error } = await getClient()
      .from(DOCUMENTS_TABLE)
      .insert(payload)
      .select('id,data,created_at,updated_at');
    if (error) {
      throw error;
    }
    return mapRow(rows[0], dateFields);
  };

  const insertMany = async (items) => {
    if (!items.length) return [];
    const now = new Date().toISOString();
    const payload = items.map((item) => ({
      collection,
      data: serializeData(item),
      created_at: now,
      updated_at: now
    }));
    const { data: rows, error } = await getClient()
      .from(DOCUMENTS_TABLE)
      .insert(payload)
      .select('id,data,created_at,updated_at');
    if (error) {
      throw error;
    }
    return (rows || []).map((row) => mapRow(row, dateFields));
  };

  const findByIdAndUpdate = async (id, updates, options = {}) => {
    const existing = await findById(id);
    if (!existing) return null;
    const updatedData = {
      ...serializeData(existing),
      ...serializeData(updates)
    };
    delete updatedData._id;
    delete updatedData.createdAt;
    delete updatedData.updatedAt;

    const { data: rows, error } = await getClient()
      .from(DOCUMENTS_TABLE)
      .update({ data: updatedData, updated_at: new Date().toISOString() })
      .eq('collection', collection)
      .eq('id', id)
      .select('id,data,created_at,updated_at');
    if (error) {
      throw error;
    }
    const updated = mapRow(rows[0], dateFields);
    return options.new === false ? existing : updated;
  };

  const findByIdAndDelete = async (id) => {
    const existing = await findById(id);
    if (!existing) return null;
    const { error } = await getClient()
      .from(DOCUMENTS_TABLE)
      .delete()
      .eq('collection', collection)
      .eq('id', id);
    if (error) {
      throw error;
    }
    return existing;
  };

  const deleteOne = async (filters = {}) => {
    const existing = await findOne(filters);
    if (!existing) return null;
    await findByIdAndDelete(existing._id);
    return existing;
  };

  const deleteMany = async (filters = {}) => {
    let query = getClient().from(DOCUMENTS_TABLE).delete().eq('collection', collection);
    query = applyFilters(query, filters, arrayFields);
    const { error } = await query;
    if (error) {
      throw error;
    }
  };

  const findOneAndUpdate = async (filters, updates, options = {}) => {
    const existing = await findOne(filters);
    if (existing) {
      return findByIdAndUpdate(existing._id, updates, options);
    }
    if (options.upsert) {
      const payload = { ...serializeData(filters), ...serializeData(updates) };
      return create(payload);
    }
    return null;
  };

  return {
    find,
    findOne,
    findById,
    create,
    insertMany,
    findByIdAndUpdate,
    findByIdAndDelete,
    deleteOne,
    deleteMany,
    findOneAndUpdate
  };
};

module.exports = {
  createModel
};
