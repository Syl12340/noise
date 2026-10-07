#[derive(Clone, Debug)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Text(String),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}
impl Value {
    pub fn number(n: f64) -> Self {
        Self::Num(n)
    }
    pub fn text(s: &str) -> Self {
        Self::Text(s.into())
    }
    pub fn object(fields: Vec<(&str, Value)>) -> Self {
        Self::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }
    pub fn get(&self, k: &str) -> Option<&Value> {
        if let Self::Object(fields) = self {
            fields.iter().find(|(key, _)| key == k).map(|(_, v)| v)
        } else {
            None
        }
    }
    pub fn get_mut(&mut self, k: &str) -> Option<&mut Value> {
        if let Self::Object(fields) = self {
            fields.iter_mut().find(|(key, _)| key == k).map(|(_, v)| v)
        } else {
            None
        }
    }
    pub fn set(&mut self, k: &str, v: Value) {
        if let Self::Object(fields) = self {
            if let Some((_, old)) = fields.iter_mut().find(|(key, _)| key == k) {
                *old = v;
            } else {
                fields.push((k.into(), v));
            }
        }
    }
    pub fn num(&self) -> Option<f64> {
        if let Self::Num(v) = self {
            Some(*v)
        } else {
            None
        }
    }
    pub fn string(&self) -> Option<&str> {
        if let Self::Text(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn array(&self) -> Option<&[Value]> {
        if let Self::Array(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn json(&self) -> String {
        match self {
            Self::Null => "null".into(),
            Self::Bool(v) => v.to_string(),
            Self::Num(v) => {
                if v.is_nan() {
                    "\"NaN\"".into()
                } else if *v == f64::INFINITY {
                    "\"+Infinity\"".into()
                } else if *v == f64::NEG_INFINITY {
                    "\"-Infinity\"".into()
                } else {
                    v.to_string()
                }
            }
            Self::Text(v) => format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\"")),
            Self::Array(a) => format!(
                "[{}]",
                a.iter().map(|v| v.json()).collect::<Vec<_>>().join(",")
            ),
            Self::Object(a) => format!(
                "{{{}}}",
                a.iter()
                    .map(|(k, v)| format!("\"{k}\":{}", v.json()))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        }
    }
}
pub fn obj(v: Vec<(&str, Value)>) -> Value {
    Value::object(v)
}
pub fn num(v: f64) -> Value {
    Value::Num(v)
}
pub fn text(v: &str) -> Value {
    Value::text(v)
}
pub fn array(v: Vec<Value>) -> Value {
    Value::Array(v)
}
